/**
 * What an external turn puts on screen, and — just as important — what it does
 * not: no re-run, no retry, no open-in-editor on a tool MangoStudio never ran,
 * and no live markup from text a third-party process wrote.
 */

import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { en } from '@mangostudio/shared/i18n';
import type {
  ExternalActivityPart,
  ExternalApprovalPart,
  MessagePart,
} from '@mangostudio/shared/types';
import { fireEvent, screen } from '@testing-library/react';
import { deriveTurnStatus } from '../../../src/features/chat/lib/turn-status';
import { stubClipboard } from '../../support/harness/clipboard';
import { render, waitFor } from '../../support/harness/render';
import { routerWithLinkStub } from '../../support/mocks/router';
import { ToolIdentitiesProbe } from '../../support/mocks/tool-identities';

// The install and update remedies link into the environments surface, so the parts render a router
// `Link`. Stubbed here, not in a preload: a module mock in a shared graph leaks into other files.
mock.module('@tanstack/react-router', await routerWithLinkStub());

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
    <ToolIdentitiesProbe>
      {(toolIdentities) => (
        <MessageParts
          parts={parts}
          messageId="msg-1"
          isStreaming={false}
          status={deriveTurnStatus(parts, false)}
          chatId={chatId}
          toolIdentities={toolIdentities}
        />
      )}
    </ToolIdentitiesProbe>
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
    expect(screen.getByText('commandExecution').className).toContain('text-danger');
  });

  it('leaves a completed vendor tool name neutral', () => {
    renderParts([turnPart(), activityPart({ name: 'commandExecution', status: 'completed' })]);
    const name = screen.getByText('commandExecution');
    expect(name.className).toContain('text-fg');
    expect(name.className).not.toContain('text-success');
  });

  // Colour alone cannot be the difference between a call that failed and one
  // that was cancelled: they differ by glyph and by word, as on a native row.
  it('tells a failed call from a cancelled one by glyph and word, not by colour', () => {
    const { container } = renderParts([
      turnPart(),
      activityPart({ callId: 'f', name: 'failing', status: 'failed', isError: true }),
      activityPart({ callId: 'c', name: 'stopped', status: 'cancelled' }),
      activityPart({ callId: 'd', name: 'finished', status: 'completed' }),
    ]);
    const rowOf = (name: string) =>
      screen.getByText(name).closest('.chat-timeline-item') as HTMLElement;

    const failed = rowOf('failing');
    expect(failed.querySelector('.lucide-circle-alert')).not.toBeNull();
    expect(failed.querySelector('.lucide-ban')).toBeNull();
    expect(failed).toHaveTextContent(en.tools.status.failed);

    const cancelled = rowOf('stopped');
    expect(cancelled.querySelector('.lucide-ban')).not.toBeNull();
    expect(cancelled.querySelector('.lucide-circle-alert')).toBeNull();
    expect(cancelled).toHaveTextContent(en.tools.status.cancelled);

    // A call that went to plan stays quiet: the node and the check carry it.
    const finished = rowOf('finished');
    expect(finished.querySelector('.lucide-check')).not.toBeNull();
    expect(finished).not.toHaveTextContent(en.tools.status.failed);
    expect(finished).not.toHaveTextContent(en.tools.status.cancelled);
    expect(container.querySelectorAll('.chat-timeline-item')).toHaveLength(3);
  });

  it('lets isError win over a completed status in the glyph, the word and the sentence', () => {
    renderParts([turnPart(), activityPart({ name: 'odd', status: 'completed', isError: true })]);
    const row = screen.getByText('odd').closest('.chat-timeline-item') as HTMLElement;
    expect(row.querySelector('.lucide-circle-alert')).not.toBeNull();
    expect(row).toHaveTextContent(en.tools.status.failed);
    expect(row).not.toHaveTextContent(en.externalAgents.activity.statusCompleted);
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

  // The card is the record of what was authorised. Once answered it says so in
  // one line, with the vendor's own label, instead of three grey tiles.
  it('shows an answered approval as a record of the chosen option, with nothing to press', () => {
    renderParts([turnPart(), approvalPart({ decision: 'approve', decisionSource: 'user' })]);

    expect(screen.getByText(/Permission answered/i)).toBeInTheDocument();
    expect(screen.getByText('Approve for this session')).toBeInTheDocument();
    expect(screen.queryByText('Deny')).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('does not read a chosen destructive option as a refusal', () => {
    const { container } = renderParts([
      turnPart(),
      approvalPart({ decision: 'deny', decisionSource: 'user' }),
    ]);

    const record = screen.getByText('Deny').closest('p') as HTMLElement;
    expect(record.dataset.destructive).toBe('true');
    // The selection mark is the same check whatever was chosen, and the option
    // keeps the warning glyph it wore as a button. No ban, no success tint.
    expect(record.querySelector('.lucide-check')).not.toBeNull();
    expect(record.querySelector('.lucide-triangle-alert')).not.toBeNull();
    expect(container.querySelector('.lucide-ban')).toBeNull();
    expect(record.querySelector('.text-success')).toBeNull();
  });

  it('keeps the inert options of a card nobody answered', () => {
    renderParts([turnPart(), approvalPart({ decisionSource: 'cancelled' })]);
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Approve for this session',
      'Deny',
    ]);
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
  });

  it('keeps the options when a decision names an option the card does not carry', () => {
    renderParts([turnPart(), approvalPart({ decision: 'ghost', decisionSource: 'user' })]);
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('turns into the record as soon as the answer is accepted', async () => {
    renderParts([turnPart({ status: 'active' }), approvalPart()]);
    fireEvent.click(screen.getByRole('button', { name: 'Approve for this session' }));

    await screen.findByText(/Permission answered/i);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText('Approve for this session')).toBeInTheDocument();
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

describe('external turn: signed out', () => {
  const SIGNED_OUT_ERROR = {
    code: 'acp-auth-required',
    message: 'authentication required; to sign in: cursor-agent login',
    vendorCode: '-32000',
  };

  it("shows the selector's signed-out words and the sign-in command instead of the raw error", () => {
    const { container } = renderParts([
      turnPart({
        targetId: 'cursor',
        terminalReason: 'vendor-error',
        error: SIGNED_OUT_ERROR,
        remedy: { kind: 'sign-in', command: 'cursor-agent login' },
      }),
    ]);

    expect({
      words: screen.queryByText('Installed, but signed out') !== null,
      command: container.querySelector('code')?.textContent,
      rawCode: screen.queryByText('acp-auth-required'),
      rawMessage: screen.queryByText(/authentication required; to sign in/),
      copy: screen.queryByRole('button', { name: 'Copy login command' }) !== null,
    }).toEqual({
      words: true,
      command: 'cursor-agent login',
      rawCode: null,
      rawMessage: null,
      copy: true,
    });
  });

  it('copies the command and offers nothing that signs in for the user', async () => {
    const writes: string[] = [];
    stubClipboard((text) => {
      writes.push(text);
      return Promise.resolve();
    });
    renderParts([
      turnPart({
        targetId: 'cursor',
        terminalReason: 'vendor-error',
        error: SIGNED_OUT_ERROR,
        remedy: { kind: 'sign-in', command: 'cursor-agent login' },
      }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Copy login command' }));

    await waitFor(() => expect(writes).toEqual(['cursor-agent login']));
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('keeps a hostile command inert: it is text, not markup', () => {
    const hostile = '<img src=x onerror=alert(1)> `rm -rf ~` [x](javascript:alert(1))';
    const { container } = renderParts([
      turnPart({
        targetId: 'cursor',
        terminalReason: 'vendor-error',
        error: SIGNED_OUT_ERROR,
        remedy: { kind: 'sign-in', command: hostile },
      }),
    ]);

    expect({
      text: container.querySelector('code')?.textContent,
      images: container.querySelectorAll('img').length,
      links: container.querySelectorAll('a').length,
    }).toEqual({ text: hostile, images: 0, links: 0 });
  });

  it('shows the raw code and message when the hub sent no remedy, as an older hub does', () => {
    renderParts([
      turnPart({ targetId: 'cursor', terminalReason: 'vendor-error', error: SIGNED_OUT_ERROR }),
    ]);

    expect(screen.getByText('acp-auth-required')).toBeInTheDocument();
    expect(screen.getByText(/authentication required; to sign in/)).toBeInTheDocument();
  });
});

describe('external turn: a resubmission the runtime refused for a state of the agent', () => {
  const START_ERROR = { code: 'turn-start', message: 'raw runtime text for the refused reopen' };
  const refusedTurn = (overrides: Partial<MessagePart & { type: 'external_turn' }>) =>
    turnPart({ terminalReason: 'vendor-error', error: START_ERROR, ...overrides });

  it('says the selector words and links the install recipes, not the runtime message', () => {
    renderParts([refusedTurn({ unavailableReason: 'not-installed', remedy: { kind: 'install' } })]);

    expect({
      words: screen.queryByText(en.externalAgents.unavailable['not-installed']) !== null,
      link: screen
        .getByRole('link', { name: en.externalAgents.remedy.install })
        .getAttribute('href'),
      rawCode: screen.queryByText('turn-start'),
      rawMessage: screen.queryByText(/raw runtime text/),
    }).toEqual({ words: true, link: '/environments/agents', rawCode: null, rawMessage: null });
  });

  it('names the build an outdated agent needs', () => {
    renderParts([
      refusedTurn({
        unavailableReason: 'version-unsupported',
        remedy: { kind: 'update' },
        requiredVersion: '0.153.4',
      }),
    ]);

    expect({
      words: screen.queryByText(/0\.153\.4/) !== null,
      link: screen.queryByRole('link', { name: en.externalAgents.remedy.update }) !== null,
    }).toEqual({ words: true, link: true });
  });

  it('says signed out with the command, never running it', () => {
    renderParts([
      refusedTurn({
        targetId: 'cursor',
        unavailableReason: 'signed-out',
        remedy: { kind: 'sign-in', command: 'cursor-agent login' },
      }),
    ]);

    expect({
      words: screen.queryByText(en.externalAgents.unavailable['signed-out']) !== null,
      copy: screen.queryByRole('button', { name: 'Copy login command' }) !== null,
      link: screen.queryByRole('link'),
    }).toEqual({ words: true, copy: true, link: null });
  });

  it('keeps hostile runtime text and a hostile version inert', () => {
    const hostile = '<img src=x onerror=alert(1)> [x](javascript:alert(1)) $&';
    const { container } = renderParts([
      refusedTurn({
        error: { code: 'turn-start', message: hostile },
        unavailableReason: 'version-unsupported',
        remedy: { kind: 'update' },
        requiredVersion: hostile,
      }),
    ]);

    expect({
      images: container.querySelectorAll('img').length,
      showsVersionAsText: container.textContent?.includes(hostile),
      links: container.querySelectorAll('a').length,
    }).toEqual({ images: 0, showsVersionAsText: true, links: 1 });
  });

  it('shows the raw code and message when an older hub stored no reason', () => {
    renderParts([refusedTurn({})]);

    expect(screen.getByText('turn-start')).toBeInTheDocument();
    expect(screen.getByText(/raw runtime text/)).toBeInTheDocument();
  });
});

describe('an external agent that could not start', () => {
  const FALLBACK = 'The external agent turn could not be started.';
  const DENIED_TEXT = "This machine's owner has not allowed external agents";

  it('says signed out in the selector words, with the command to run and copy', () => {
    const { container } = renderParts([
      {
        type: 'error',
        text: FALLBACK,
        unavailableReason: 'signed-out',
        remedy: { kind: 'sign-in', command: 'codex login' },
      },
    ]);

    expect({
      words: screen.queryByText('Installed, but signed out') !== null,
      fallback: screen.queryByText(FALLBACK),
      command: container.querySelector('code')?.textContent,
      copy: screen.queryByRole('button', { name: 'Copy login command' }) !== null,
    }).toEqual({ words: true, fallback: null, command: 'codex login', copy: true });
  });

  it('keeps a hostile command inert', () => {
    const hostile = '<img src=x onerror=alert(1)> `rm -rf ~`';
    const { container } = renderParts([
      {
        type: 'error',
        text: FALLBACK,
        unavailableReason: 'signed-out',
        remedy: { kind: 'sign-in', command: hostile },
      },
    ]);

    expect({
      text: container.querySelector('code')?.textContent,
      images: container.querySelectorAll('img').length,
    }).toEqual({ text: hostile, images: 0 });
  });

  it('says a withdrawn consent in its own words, with no command', () => {
    const { container } = renderParts([
      {
        type: 'error',
        text: FALLBACK,
        unavailableReason: 'runtime-denied',
        remedy: { kind: 'contact-admin' },
      },
    ]);

    expect({
      fallback: screen.queryByText(FALLBACK),
      reason: screen.queryByText(DENIED_TEXT)?.textContent,
      commands: container.querySelectorAll('code').length,
    }).toEqual({ fallback: null, reason: DENIED_TEXT, commands: 0 });
  });

  it('says a missing executable as not installed, with the install link and no command', () => {
    const { container } = renderParts([
      {
        type: 'error',
        text: FALLBACK,
        unavailableReason: 'not-installed',
        remedy: { kind: 'install' },
      },
    ]);

    expect({
      fallback: screen.queryByText(FALLBACK),
      reason: screen.queryByText(en.externalAgents.unavailable['not-installed']) !== null,
      link: container.querySelector('a')?.getAttribute('href'),
      linkText: container.querySelector('a')?.textContent,
      commands: container.querySelectorAll('code').length,
    }).toEqual({
      fallback: null,
      reason: true,
      link: '/environments/agents',
      linkText: en.externalAgents.remedy.install,
      commands: 0,
    });
  });

  it('says an outdated agent with the build it needs and the update link', () => {
    const { container } = renderParts([
      {
        type: 'error',
        text: FALLBACK,
        unavailableReason: 'version-unsupported',
        remedy: { kind: 'update' },
        requiredVersion: '0.153.4',
      },
    ]);

    expect({
      fallback: screen.queryByText(FALLBACK),
      reason: screen.queryByText(/Update this agent to 0\.153\.4 or later/) !== null,
      linkText: container.querySelector('a')?.textContent,
    }).toEqual({ fallback: null, reason: true, linkText: en.externalAgents.remedy.update });
  });

  it('names no build when an older runtime sent none, without printing the placeholder', () => {
    const { container } = renderParts([
      {
        type: 'error',
        text: FALLBACK,
        unavailableReason: 'version-unsupported',
        remedy: { kind: 'update' },
      },
    ]);

    expect({
      placeholder: container.textContent?.includes('{version}'),
      generic: container.textContent?.includes(en.externalAgents.selector.unknownVersion),
    }).toEqual({ placeholder: false, generic: true });
  });

  it('keeps a hostile required version inert text', () => {
    const hostile = '<img src=x onerror=alert(1)> $& `rm -rf ~`';
    const { container } = renderParts([
      {
        type: 'error',
        text: FALLBACK,
        unavailableReason: 'version-unsupported',
        remedy: { kind: 'update' },
        requiredVersion: hostile,
      },
    ]);

    expect({
      shown: container.textContent?.includes(hostile),
      images: container.querySelectorAll('img').length,
    }).toEqual({ shown: true, images: 0 });
  });

  it('says the session cap in plain words, with no command and no link', () => {
    const { container } = renderParts([
      { type: 'error', text: FALLBACK, code: 'external_agent_capacity' },
    ]);

    expect({
      fallback: screen.queryByText(FALLBACK),
      cap: screen.queryByText(en.externalAgents.openFailure.capacity) !== null,
      commands: container.querySelectorAll('code').length,
      links: container.querySelectorAll('a').length,
    }).toEqual({ fallback: null, cap: true, commands: 0, links: 0 });
  });

  it('keeps the sentence for a failed open and shows its kind as plain text to quote to support', () => {
    const { container } = renderParts([
      { type: 'error', text: FALLBACK, code: 'external_agent_launch_failed' },
    ]);

    expect({
      sentence: screen.queryByText(FALLBACK) !== null,
      kind: screen.queryByText('external_agent_launch_failed')?.tagName,
      commands: container.querySelectorAll('code').length,
      links: container.querySelectorAll('a').length,
    }).toEqual({ sentence: true, kind: 'SPAN', commands: 0, links: 0 });
  });

  it('does not show a kind beside a reason it already says in the selector words', () => {
    renderParts([
      {
        type: 'error',
        text: FALLBACK,
        code: 'external_agent_not_installed',
        unavailableReason: 'not-installed',
        remedy: { kind: 'install' },
      },
    ]);

    expect(screen.queryByText('external_agent_not_installed')).toBeNull();
  });

  it('shows the plain text for a code it has no copy for, and never the code itself', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { container } = renderParts([{ type: 'error', text: FALLBACK, code: hostile }]);

    expect({
      text: screen.queryByText(FALLBACK) !== null,
      shownCode: container.textContent?.includes(hostile),
      images: container.querySelectorAll('img').length,
    }).toEqual({ text: true, shownCode: false, images: 0 });
  });

  it('shows the plain text when the hub sent no reason, as an older hub does', () => {
    renderParts([{ type: 'error', text: FALLBACK }]);

    expect(screen.getByText(FALLBACK)).toBeInTheDocument();
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
      <ToolIdentitiesProbe>
        {(toolIdentities) => (
          <MessageParts
            parts={parts}
            messageId="msg-1"
            isStreaming
            status={deriveTurnStatus(parts, true)}
            toolIdentities={toolIdentities}
          />
        )}
      </ToolIdentitiesProbe>
    );
    expect(screen.queryByText('Working')).toBeNull();
  });
});

describe('a conversation the agent did not continue', () => {
  it.each([
    ['nonresumable', en.externalAgents.turn.conversationReset.nonresumable],
    ['unavailable', en.externalAgents.turn.conversationReset.unavailable],
  ] as const)('says so for %s, beside the reply', (reason, words) => {
    renderParts([
      turnPart({ status: 'terminal', terminalReason: 'completed', conversationReset: reason }),
      { type: 'text', text: 'a fresh answer' },
    ]);

    const notice = screen.getByRole('status');
    expect(
      { text: notice.textContent, reason: notice.getAttribute('data-conversation-reset') },
      `expected the ${reason} notice under the reply`
    ).toEqual({ text: words, reason });
  });

  it('says nothing for a turn that continued its conversation', () => {
    renderParts([
      turnPart({ status: 'terminal', terminalReason: 'completed' }),
      { type: 'text', text: 'an answer' },
    ]);
    expect(screen.queryByRole('status')).toBeNull();
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
