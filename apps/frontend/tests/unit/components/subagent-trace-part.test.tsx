/**
 * The stored `subagent_trace.messages` list used to hold one `system` entry per
 * reasoning token; the API now folds a run of reasoning deltas into one entry.
 * Rows written before that still carry the per-token shape, so the card has to
 * read both and show the same reasoning text.
 */

import { describe, expect, it } from 'bun:test';

import type { MessagePart } from '@mangostudio/shared/types';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SubagentTracePart } from '../../../src/features/chat/components/parts/SubagentTracePart';
import { render } from '../../support/harness/render';

type SubagentTrace = Extract<MessagePart, { type: 'subagent_trace' }>;

const REASONING_TOKENS = ['Check ', 'the ', 'config ', 'file.'];

function createTrace(messages: SubagentTrace['messages']): SubagentTrace {
  return {
    type: 'subagent_trace',
    toolCallId: 'call-trace-shapes',
    agentId: 'explorer',
    agentName: 'Explorer',
    status: 'completed',
    summary: 'Found it',
    lastMessage: 'Found it',
    toolCallCount: 0,
    messages,
    tools: [],
  };
}

async function expandedReasoningText(trace: SubagentTrace): Promise<string> {
  const user = userEvent.setup();
  const { container } = render(<SubagentTracePart part={trace} />);
  await user.click(screen.getByRole('button', { name: /Explorer/ }));
  return container.textContent ?? '';
}

describe('SubagentTracePart reasoning entries', () => {
  it('shows a folded reasoning entry as one block with the full text', async () => {
    const text = await expandedReasoningText(
      createTrace([
        { role: 'system', text: REASONING_TOKENS.join('') },
        { role: 'assistant', text: 'Found it' },
      ])
    );

    expect(text, '(subagent trace): expected folded reasoning text in the card').toContain(
      'Check the config file.'
    );
  });

  it('still reads a legacy row with one entry per reasoning token', async () => {
    const text = await expandedReasoningText(
      createTrace([
        ...REASONING_TOKENS.map((token) => ({ role: 'system' as const, text: token })),
        { role: 'assistant', text: 'Found it' },
      ])
    );

    for (const token of REASONING_TOKENS) {
      expect(text, `(subagent trace): expected legacy token ${JSON.stringify(token)}`).toContain(
        token.trim()
      );
    }
  });
});
