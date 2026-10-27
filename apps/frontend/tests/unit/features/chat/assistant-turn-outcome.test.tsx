/**
 * The line under a turn states how long it took, and how it ended. "Responded
 * in 12.8s" under a rate-limit error told the reader the turn above it had
 * succeeded.
 */

import { describe, expect, it } from 'bun:test';

import type { Message } from '@mangostudio/shared/chat';
import type { ExternalTurnTerminalReason } from '@mangostudio/shared/external-agents';
import { createMockMessage } from '@mangostudio/shared/test-utils';
import type { MessagePart } from '@mangostudio/shared/types';
import { screen } from '@testing-library/react';

import { AssistantMessageBlock } from '../../../../src/features/chat/components/AssistantMessageBlock';
import { render } from '../../../support/harness/render';
import { ToolIdentitiesProbe } from '../../../support/mocks/tool-identities';

function renderTurn(
  parts: MessagePart[],
  generationTime: string | undefined = '12.8s',
  overrides: Partial<Message> = {},
  isImageTurn = false
) {
  const msg = createMockMessage({
    role: 'ai',
    modelName: 'gpt-5.2',
    isGenerating: false,
    generationTime,
    parts,
    ...overrides,
  });
  return render(
    <ToolIdentitiesProbe>
      {(toolIdentities) => (
        <AssistantMessageBlock
          msg={msg}
          isImageTurn={isImageTurn}
          toolIdentities={toolIdentities}
        />
      )}
    </ToolIdentitiesProbe>
  );
}

function externalTurn(terminalReason: ExternalTurnTerminalReason): MessagePart {
  return {
    type: 'external_turn',
    version: 1,
    targetId: 'codex',
    sessionId: 'session-1',
    status: 'terminal',
    terminalReason,
    startedAt: 0,
    updatedAt: 0,
    lastSequence: 1,
    eventCount: 1,
    persistedBytes: 10,
  } as MessagePart;
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

  it('explains an external turn the hub ended on the same line, with its time', () => {
    renderTurn([externalTurn('runtime-disconnected'), { type: 'text', text: 'Partial.' }], '4.2s');

    expect(
      screen.getByText('The connection to that machine dropped mid-turn.')
    ).toBeInTheDocument();
    expect(screen.getByText('4.2s')).toBeInTheDocument();
    expect(screen.queryByText(/Responded in/)).not.toBeInTheDocument();
  });

  it('says once that the person stopped an external turn', () => {
    renderTurn([externalTurn('cancelled-by-user'), { type: 'text', text: 'Partial.' }], undefined);

    expect(screen.getAllByText('You stopped this turn.')).toHaveLength(1);
  });

  it('stays quiet about why an external turn that finished ended', () => {
    renderTurn([externalTurn('completed'), { type: 'text', text: 'Done.' }]);

    expect(screen.getByText('Responded in 12.8s')).toBeInTheDocument();
    expect(screen.queryByText(/connection to that machine dropped/i)).not.toBeInTheDocument();
  });

  it('closes a legacy image turn on the same line, below the picture', () => {
    renderTurn([], '1.2s', { interactionMode: 'image', imageUrl: '/images/a.png' }, true);

    expect(screen.getByText('Responded in 1.2s')).toBeInTheDocument();
    expect(screen.queryByText(/Thought for/)).not.toBeInTheDocument();
  });
});
