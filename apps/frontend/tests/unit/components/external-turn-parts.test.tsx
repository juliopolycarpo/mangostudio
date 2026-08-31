/**
 * What an external turn puts on screen, and — just as important — what it does
 * not: no re-run, no retry, no open-in-editor on a tool MangoStudio never ran,
 * and no live markup from text a third-party process wrote.
 */

import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import type {
  ExternalActivityPart,
  ExternalApprovalPart,
  MessagePart,
} from '@mangostudio/shared/types';
import { fireEvent, screen } from '@testing-library/react';
import { deriveTurnStatus } from '../../../src/features/chat/lib/turn-status';
import { render, waitFor } from '../../support/harness/render';

const answerExternalApproval =
  jest.fn<(chatId: string, body: { requestId: string; optionId: string }) => Promise<unknown>>();

mock.module('../../../src/services/external-agent-service', () => ({
  answerExternalApproval: (chatId: string, body: { requestId: string; optionId: string }) =>
    answerExternalApproval(chatId, body),
}));

// After the mock, never before: a static import is evaluated first and would
// bind MessageParts to the real external-agent service.
const { MessageParts } = await import('../../../src/features/chat/components/MessageParts');

function turnPart(overrides: Partial<MessagePart & { type: 'external_turn' }> = {}): MessagePart {
  return {
    type: 'external_turn',
    version: 1,
    targetId: 'codex',
    sessionId: 'session-1',
    status: 'terminal',
    terminalReason: 'completed',
    startedAt: 0,
    updatedAt: 0,
    lastSequence: 1,
    eventCount: 1,
    persistedBytes: 10,
    ...overrides,
  } as MessagePart;
}

function activityPart(overrides: Partial<ExternalActivityPart> = {}): ExternalActivityPart {
  return {
    type: 'external_activity',
    targetId: 'codex',
    callId: 'call-1',
    name: 'shell',
    kind: 'command',
    title: 'bun run build',
    status: 'completed',
    ...overrides,
  };
}

function approvalPart(overrides: Partial<ExternalApprovalPart> = {}): ExternalApprovalPart {
  return {
    type: 'external_approval',
    targetId: 'codex',
    requestId: 'req-1',
    kind: 'command',
    title: 'Run `rm -rf build`',
    options: [
      { id: 'approve', rawLabel: 'Approve for this session', isDestructive: false },
      { id: 'deny', rawLabel: 'Deny', isDestructive: true },
    ],
    // Far enough out that the local expiry timer never fires mid-test.
    expiresAtMs: Date.now() + 600_000,
    ...overrides,
  };
}

function renderParts(parts: MessagePart[], chatId: string | null = 'chat-1') {
  return render(
    <MessageParts
      parts={parts}
      messageId="msg-1"
      isStreaming={false}
      status={deriveTurnStatus(parts, false)}
      chatId={chatId}
    />
  );
}

beforeEach(() => {
  answerExternalApproval.mockReset();
  answerExternalApproval.mockResolvedValue({ status: 'accepted' });
});

describe('external activity row', () => {
  // A vendor turn renders on the same rail as a MangoStudio one, or a Codex
  // transcript reads as a different product from the chat it is sitting in.
  it('sits on the timeline with a node toned by the vendor status', () => {
    const { container } = renderParts([
      turnPart(),
      activityPart({ callId: 'a', status: 'completed' }),
      activityPart({ callId: 'b', status: 'running' }),
      activityPart({ callId: 'c', status: 'failed', isError: true }),
      activityPart({ callId: 'd', status: 'cancelled' }),
    ]);

    expect(container.querySelectorAll('.chat-timeline-item--success')).toHaveLength(1);
    expect(container.querySelectorAll('.chat-timeline-item--active')).toHaveLength(1);
    expect(container.querySelectorAll('.chat-timeline-item--error')).toHaveLength(1);
    expect(container.querySelectorAll('.chat-timeline-item--muted')).toHaveLength(1);
  });

  it('colours the vendor tool name by the same outcome', () => {
    renderParts([turnPart(), activityPart({ name: 'commandExecution', status: 'failed' })]);
    expect(screen.getByText('commandExecution').className).toContain('text-error');
  });

  // A row with nothing to open must not advertise a disclosure it cannot
  // honour — nor cost a tab stop for it. A turn that ran twenty commands would
  // otherwise put twenty dead stops between the user and the next real control.
  it('renders an activity with no detail as an inert row, not a tab stop', () => {
    const { container } = renderParts([turnPart(), activityPart({ detail: undefined })]);
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('[aria-expanded]')).toBeNull();
  });

  it("shows the vendor's own tool name verbatim", () => {
    renderParts([turnPart(), activityPart({ name: 'my_weird.tool-NAME' })]);
    expect(screen.getByText('my_weird.tool-NAME')).toBeInTheDocument();
  });

  it('renders a name containing markup as inert text', () => {
    const hostile = '[click me](https://evil.example) <img src=x onerror=alert(1)>';
    const { container } = renderParts([turnPart(), activityPart({ name: hostile })]);
    expect(screen.getByText(hostile)).toBeInTheDocument();
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('offers no re-run, retry or open-in-editor control', () => {
    renderParts([turnPart(), activityPart({ detail: 'exit 0' })]);
    const buttons = screen.getAllByRole('button');
    // Exactly one: the disclosure for the detail. Nothing that would act.
    expect(buttons).toHaveLength(1);
    for (const label of [/re-?run/i, /retry/i, /open in/i, /revert/i]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
  });

  it('falls back to a readable default name when no identity row exists', () => {
    renderParts([turnPart(), activityPart()]);
    // The built-in product name is the common path: most users never rename.
    expect(screen.getByText(/Run by /)).toBeInTheDocument();
  });
});

describe('external approval card', () => {
  it('renders the vendor options in the vendor order, with the vendor labels', () => {
    renderParts([turnPart({ status: 'active' }), approvalPart()]);
    const buttons = screen.getAllByRole('button').map((button) => button.textContent);
    expect(buttons).toEqual(['Approve for this session', 'Deny']);
  });

  it('marks a destructive option without removing it', () => {
    renderParts([turnPart({ status: 'active' }), approvalPart()]);
    const deny = screen.getByRole('button', { name: 'Deny' });
    expect(deny.dataset.destructive).toBe('true');
    expect(deny).toBeEnabled();
  });

  it('posts the option id that was pressed', async () => {
    renderParts([turnPart({ status: 'active' }), approvalPart()]);
    fireEvent.click(screen.getByRole('button', { name: 'Approve for this session' }));
    await waitFor(() => {
      expect(answerExternalApproval).toHaveBeenCalledWith('chat-1', {
        requestId: 'req-1',
        optionId: 'approve',
      });
    });
  });

  it('renders an abandoned approval as expired rather than as a live control', () => {
    renderParts([turnPart(), approvalPart({ decisionSource: 'expired' })]);
    expect(screen.getByText(/Permission expired/i)).toBeInTheDocument();
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
  });

  it('stays answerable when the server rejects the decision', async () => {
    answerExternalApproval.mockResolvedValue({ status: 'rejected', reason: 'expired' });
    renderParts([turnPart({ status: 'active' }), approvalPart()]);

    fireEvent.click(screen.getByRole('button', { name: 'Approve for this session' }));
    await screen.findByText(/could not be sent/i);

    // The vendor never received that authorization, so the card must not claim
    // it did — and the user must be able to try the other option.
    expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled();
  });

  it('goes inert once the approval outlives its own deadline', () => {
    renderParts([
      turnPart({ status: 'active' }),
      approvalPart({ expiresAtMs: Date.now() - 1_000 }),
    ]);
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
    expect(screen.getByText(/Permission expired/i)).toBeInTheDocument();
  });

  it('renders a reloaded pending approval inert when it is not the live chat', () => {
    renderParts([turnPart(), approvalPart()], null);
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
    expect(answerExternalApproval).not.toHaveBeenCalled();
  });
});

describe('external turn summary', () => {
  it('renders only the usage fields the vendor reported, and computes no total', () => {
    renderParts([turnPart({ usage: { inputTokens: 1200, outputTokens: 34 } })]);
    expect(screen.getByText('in 1.2k')).toBeInTheDocument();
    expect(screen.getByText('out 34')).toBeInTheDocument();
    expect(screen.queryByText(/total/i)).toBeNull();
  });

  it('explains a turn the hub ended, and stays quiet about one that finished', () => {
    const { unmount } = renderParts([turnPart({ terminalReason: 'runtime-disconnected' })]);
    expect(screen.getByText(/connection to that machine dropped/i)).toBeInTheDocument();
    unmount();

    renderParts([turnPart({ terminalReason: 'completed' })]);
    expect(screen.queryByText(/connection to that machine dropped/i)).toBeNull();
  });

  it("keeps the vendor's error code and message rather than flattening them", () => {
    renderParts([
      turnPart({
        terminalReason: 'vendor-error',
        error: { code: 'sandbox_denied', message: 'workspace-write refused', vendorCode: 'E_SBX' },
      }),
    ]);
    expect(screen.getByText('sandbox_denied')).toBeInTheDocument();
    expect(screen.getByText(/workspace-write refused/)).toBeInTheDocument();
  });
});

describe('external turn: still working', () => {
  it('shows a working row while the turn is active and has produced nothing yet', () => {
    renderParts([turnPart({ status: 'active' })]);
    expect(screen.getByText('Working')).toBeInTheDocument();
  });

  it('shows a working row in the gap between two tool calls', () => {
    renderParts([turnPart({ status: 'active' }), activityPart({ status: 'completed' })]);
    expect(screen.getByText('Working')).toBeInTheDocument();
  });

  // A call still running already renders as running. A second row under it
  // reads as a *second* thing happening, which is one more than there is.
  it('does not duplicate the cue under a call that is still running', () => {
    renderParts([turnPart({ status: 'active' }), activityPart({ status: 'running' })]);
    expect(screen.queryByText('Working')).toBeNull();
  });

  it('stays quiet once the turn is terminal', () => {
    renderParts([turnPart({ status: 'terminal', terminalReason: 'completed' })]);
    expect(screen.queryByText('Working')).toBeNull();
  });

  // The trailing text already shows its own caret while it streams — a second
  // cue saying the same thing would be redundant right where it matters least.
  it('does not duplicate the cue over text that is actively streaming', () => {
    const parts: MessagePart[] = [
      turnPart({ status: 'active' }),
      { type: 'text', text: 'partial' },
    ];
    render(
      <MessageParts
        parts={parts}
        messageId="msg-1"
        isStreaming
        status={deriveTurnStatus(parts, true)}
      />
    );
    expect(screen.queryByText('Working')).toBeNull();
  });
});

describe('an unfinished section', () => {
  it('marks the trailing text as cut off', () => {
    renderParts([
      turnPart({ status: 'terminal', terminalReason: 'cancelled-by-user' }),
      { type: 'text', text: 'partial', incomplete: true },
    ]);
    expect(screen.getByText('Cut off.')).toBeInTheDocument();
  });

  it('marks the trailing thinking row as cut off, visible without expanding it', () => {
    renderParts([
      turnPart({ status: 'terminal', terminalReason: 'cancelled-by-user' }),
      { type: 'thinking', text: 'reasoning', incomplete: true },
    ]);
    // The block auto-collapses once a finished turn stops streaming into it —
    // the marker has to survive that collapse, which unmounts the disclosure.
    expect(screen.getByText(/Cut off\./)).toBeInTheDocument();
  });

  it('says nothing extra about a part that finished normally', () => {
    renderParts([turnPart(), { type: 'text', text: 'done' }]);
    expect(screen.queryByText('Cut off.')).toBeNull();
  });
});

describe('vendor prose', () => {
  const VENDOR_MARKDOWN = '# A heading\n\n**bold** and [link](https://ok.example)';
  // Everything a renderer is asked to neutralize, in one blob: raw html, an
  // unsafe scheme, an image that would otherwise fetch a remote pixel, and
  // html smuggled into a link label.
  const HOSTILE_MARKDOWN = [
    '<img src=x onerror="alert(1)">',
    '[js](javascript:alert(1))',
    '![pixel](https://evil.example/p.png)',
    '[label <svg onload="alert(1)">](https://ok.example)',
  ].join('\n\n');

  it('renders vendor prose as markdown, the same as a MangoStudio turn', async () => {
    const { container } = renderParts([turnPart(), { type: 'text', text: VENDOR_MARKDOWN }]);

    // The markdown renderer is lazy-loaded behind Suspense, whose fallback
    // prints the source text — a synchronous query would read the fallback and
    // pass against the very output this asserts on.
    await screen.findByText('A heading');
    expect(container.querySelector('h1')).toHaveTextContent('A heading');
    expect(container.querySelector('strong')).toHaveTextContent('bold');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://ok.example');
  });

  it('renders vendor reasoning as markdown once its block is opened', async () => {
    const { container } = renderParts([turnPart(), { type: 'thinking', text: VENDOR_MARKDOWN }]);
    // The thinking block starts collapsed on a finished turn, so its body is not
    // in the document until it is opened.
    fireEvent.click(screen.getAllByRole('button')[0] as HTMLElement);

    await screen.findByText('A heading');
    expect(container.querySelector('h1')).toHaveTextContent('A heading');
  });

  it('keeps hostile vendor markup inert', async () => {
    const { container } = renderParts([turnPart(), { type: 'text', text: HOSTILE_MARKDOWN }]);
    await screen.findByText(/<img src=x/);

    // Raw html is escaped rather than parsed, no scheme outside http(s)/mailto
    // survives, and an image renders as a link instead of fetching anything.
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).toBeNull();
    const hrefs = Array.from(container.querySelectorAll('a'), (a) => a.getAttribute('href'));
    expect(hrefs).toContain('#');
    expect(hrefs).not.toContain('javascript:alert(1)');
    for (const anchor of container.querySelectorAll('a')) {
      expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it('leaves a MangoStudio turn on the markdown path', async () => {
    const { container } = renderParts([{ type: 'text', text: VENDOR_MARKDOWN }]);
    await screen.findByText('A heading');
    expect(container.querySelector('h1')).toBeInTheDocument();
  });
});
