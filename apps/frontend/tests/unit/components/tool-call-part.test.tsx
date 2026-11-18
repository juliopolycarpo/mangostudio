import { describe, expect, it } from 'bun:test';

import type { MessagePart } from '@mangostudio/shared/types';
import { screen } from '@testing-library/react';

import { ToolCallPart } from '@/features/chat/components/parts/ToolCallPart';

import { render } from '../../support/harness/render';

const FAILED_PARTS: MessagePart[] = [
  { type: 'tool_call', toolCallId: 'call-1', name: 'bash', args: { command: 'false' } },
  { type: 'tool_result', toolCallId: 'call-1', content: '{"error":"boom"}', isError: true },
];

function renderFailedCall(isStreaming: boolean) {
  const part = FAILED_PARTS[0];
  if (part.type !== 'tool_call') throw new Error('fixture: expected a tool_call part first');
  return render(
    <ToolCallPart part={part} parts={FAILED_PARTS} index={0} isStreaming={isStreaming} />
  );
}

describe('ToolCallPart failure expansion', () => {
  it('opens a failed call while its turn is streaming', () => {
    renderFailedCall(true);
    expect(screen.getByRole('button', { name: /Bash/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('leaves a failed call in a settled turn collapsed', () => {
    renderFailedCall(false);
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('boom')).not.toBeInTheDocument();
  });
});
