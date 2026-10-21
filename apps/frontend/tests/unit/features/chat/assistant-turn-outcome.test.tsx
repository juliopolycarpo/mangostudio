/**
 * The line under a turn states how long it took, and how it ended. "Responded
 * in 12.8s" under a rate-limit error told the reader the turn above it had
 * succeeded.
 */

import { describe, expect, it } from 'bun:test';
import { createMockMessage } from '@mangostudio/shared/test-utils';
import type { MessagePart } from '@mangostudio/shared/types';
import { screen } from '@testing-library/react';
import { AssistantMessageBlock } from '../../../../src/features/chat/components/AssistantMessageBlock';
import { render } from '../../../support/harness/render';
import { ToolIdentitiesProbe } from '../../../support/mocks/tool-identities';

function renderTurn(parts: MessagePart[], generationTime = '12.8s') {
  const msg = createMockMessage({
    role: 'ai',
    modelName: 'gpt-5.2',
    isGenerating: false,
    generationTime,
    parts,
  });
  return render(
    <ToolIdentitiesProbe>
      {(toolIdentities) => (
        <AssistantMessageBlock msg={msg} isImageTurn={false} toolIdentities={toolIdentities} />
      )}
    </ToolIdentitiesProbe>
  );
}

describe('the turn cost line', () => {
  it('says "Responded in" for a turn that finished', () => {
    renderTurn([{ type: 'text', text: 'Done.' }]);

    expect(screen.getByText('Responded in 12.8s')).toBeInTheDocument();
  });

  it('says "Failed after" under an error, not that the turn responded', () => {
    renderTurn([{ type: 'error', text: 'HTTP 429: rate limited' }]);

    expect(screen.getByText('Failed after 12.8s')).toBeInTheDocument();
    expect(screen.queryByText(/Responded in/)).not.toBeInTheDocument();
  });

  it('says "Stopped after" for a turn that was interrupted', () => {
    renderTurn(
      [
        { type: 'text', text: 'Partial.' },
        {
          type: 'turn_checkpoint',
          version: 1,
          turnId: 'turn-1',
          status: 'interrupted',
          reasonCode: 'client_disconnect',
          sequence: 1,
          startedAt: 1,
          checkpointedAt: 2,
          provider: 'openai',
          modelName: 'gpt-5.2',
          agentId: 'default',
          lastAssistantText: 'Partial.',
          todoSnapshot: [],
          completedCalls: [],
          incompleteCalls: [],
        },
      ],
      '5m 02s'
    );

    expect(screen.getByText('Stopped after 5m 02s')).toBeInTheDocument();
    expect(screen.queryByText(/Responded in/)).not.toBeInTheDocument();
  });
});
