/**
 * ElicitationCard treats the server part status as authoritative: a mounted
 * card must lose its controls the moment the prop turns terminal (live SSE
 * status or refetch), and a stale 404 submit must reconcile silently instead
 * of showing the generic submit error.
 */

import { describe, expect, it, jest, mock } from 'bun:test';

import type { MessagePart } from '@mangostudio/shared/types';

import { fireEvent, render, screen, waitFor, within } from '../../../support/harness/render';

const respondMock = jest.fn();

// Import the real namespace, register the mock over it, then import the
// subject — `mock.module` is not hoisted and static imports are.
const actualService = await import('../../../../src/services/mcp-elicitation-service');

void mock.module('../../../../src/services/mcp-elicitation-service', () => ({
  ...actualService,
  respondMcpElicitation: respondMock,
}));

const { McpElicitationGoneError } = actualService;
const { ElicitationCard } =
  await import('../../../../src/features/chat/components/ElicitationCard');

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
  // The same idiom a question card uses: options grouped under the field's own
  // words, a round face for a pick-one field and a square one for pick-several,
  // and a free-text field named by its label.
  it('names each field and draws its options by how many it takes', () => {
    render(
      <ElicitationCard
        part={makePart({
          fields: [
            {
              name: 'tier',
              title: 'Tier',
              required: true,
              kind: 'enum',
              options: [
                { value: 'free', label: 'Free' },
                { value: 'pro', label: 'Pro' },
              ],
            },
            {
              name: 'regions',
              title: 'Regions',
              required: false,
              kind: 'multi_enum',
              options: [{ value: 'eu', label: 'EU' }],
            },
            { name: 'email', title: 'Email', required: false, kind: 'string' },
          ],
        })}
      />
    );

    const tier = screen.getByRole('group', { name: 'Tier' });
    const free = within(tier).getByRole('button', { name: 'Free' });
    expect(free.querySelector('[data-choice-kind]')).toHaveAttribute('data-choice-kind', 'one');
    const regions = screen.getByRole('group', { name: 'Regions' });
    expect(
      within(regions).getByRole('button', { name: 'EU' }).querySelector('[data-choice-kind]')
    ).toHaveAttribute('data-choice-kind', 'several');
    expect(screen.getByRole('textbox', { name: 'Email' })).toBeInTheDocument();
  });

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
