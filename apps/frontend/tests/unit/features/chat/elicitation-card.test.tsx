/**
 * ElicitationCard treats the server part status as authoritative: a mounted
 * card must lose its controls the moment the prop turns terminal (live SSE
 * status or refetch), and a stale 404 submit must reconcile silently instead
 * of showing the generic submit error.
 */

import { describe, expect, it, jest, mock } from 'bun:test';
import type { MessagePart } from '@mangostudio/shared';
import { fireEvent, render, screen, waitFor } from '../../../support/harness/render';

const respondMock = jest.fn();

// Import the real namespace, register the mock over it, then import the
// subject — `mock.module` is not hoisted and static imports are.
const actualService = await import('../../../../src/services/mcp-elicitation-service');

mock.module('../../../../src/services/mcp-elicitation-service', () => ({
  ...actualService,
  respondMcpElicitation: respondMock,
}));

const { McpElicitationGoneError } = actualService;
const { ElicitationCard } = await import(
  '../../../../src/features/chat/components/ElicitationCard'
);

type ElicitationPart = Extract<MessagePart, { type: 'mcp_elicitation' }>;

function makePart(overrides: Partial<ElicitationPart> = {}): ElicitationPart {
  return {
    type: 'mcp_elicitation',
    elicitationId: 'elicit-1',
    toolCallId: 'tool-mcp',
    serverSlug: 'demo',
    message: 'Choose a tier',
    fields: [],
    status: 'pending',
    ...overrides,
  };
}

describe('ElicitationCard', () => {
  it('disables a mounted card when the part prop turns terminal', () => {
    const { rerender } = render(<ElicitationCard part={makePart()} />);
    expect(screen.getByRole('button', { name: 'Submit' })).toBeTruthy();

    rerender(<ElicitationCard part={makePart({ status: 'declined' })} />);

    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
    expect(screen.getByText('Declined')).toBeTruthy();
  });

  it('renders a refetched terminal part non-interactive from the start', () => {
    render(<ElicitationCard part={makePart({ status: 'cancelled' })} />);
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
    expect(screen.getByText('Cancelled')).toBeTruthy();
  });

  it('shows the terminal state after a successful response', async () => {
    respondMock.mockResolvedValueOnce({ ok: true, status: 'accepted' });
    render(<ElicitationCard part={makePart()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() => expect(screen.getByText('Responded')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
  });

  it('reconciles a stale 404 without showing the generic submit error', async () => {
    respondMock.mockRejectedValueOnce(new McpElicitationGoneError('gone'));
    render(<ElicitationCard part={makePart()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(respondMock).toHaveBeenCalled());
    expect(screen.queryByText('Could not send your response. Try again.')).toBeNull();
  });

  it('keeps the generic submit error for real failures', async () => {
    respondMock.mockRejectedValueOnce(new Error('network down'));
    render(<ElicitationCard part={makePart()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));

    await waitFor(() =>
      expect(screen.getByText('Could not send your response. Try again.')).toBeTruthy()
    );
  });
});
