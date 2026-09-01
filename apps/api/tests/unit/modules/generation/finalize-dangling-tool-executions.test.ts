import { describe, expect, it } from 'bun:test';
import type { MessagePart } from '@mangostudio/shared';
import {
  applyToolExecutionTransition,
  createToolExecutionSnapshot,
} from '@mangostudio/shared/tool-executions';
import { finalizeDanglingToolExecutions } from '../../../../src/modules/generation/application/stream-text-turn-helpers';

describe('finalizeDanglingToolExecutions', () => {
  it('cancels a tool_call still carrying a live lifecycle snapshot', () => {
    const running = applyToolExecutionTransition(
      createToolExecutionSnapshot('builtin', Date.now()),
      {
        status: 'running',
        at: Date.now(),
      }
    );
    const parts: MessagePart[] = [
      {
        type: 'tool_call',
        toolCallId: 'call-1',
        name: 'generate_image',
        args: {},
        execution: running,
      },
    ];

    finalizeDanglingToolExecutions(parts);

    const call = parts.find((part) => part.type === 'tool_call');
    expect(call).toMatchObject({ execution: { status: 'cancelled', reasonCode: 'turn_aborted' } });
  });

  it('seals a generated_image part still generating when the turn finalized successfully', () => {
    // A throw swallowed into an `isError` tool result lets `generateText` return
    // normally: `finalizeSuccessfulTurn` never routes through
    // `reconcileInterruptedMessageParts`, so without this the card the frontend
    // renders keeps pulsing at `generating` for the life of the message.
    const parts: MessagePart[] = [
      {
        type: 'generated_image',
        imageId: 'img-1',
        toolCallId: 'image-1',
        status: 'generating',
        prompt: 'Paint mangoes',
      },
      {
        type: 'generated_image',
        imageId: 'img-2',
        toolCallId: 'image-1',
        status: 'completed',
        prompt: 'Paint mangoes',
        imageUrl: '/images/img-2.png',
      },
    ];

    finalizeDanglingToolExecutions(parts);

    const pending = parts.find(
      (part) => part.type === 'generated_image' && part.imageId === 'img-1'
    );
    const landed = parts.find(
      (part) => part.type === 'generated_image' && part.imageId === 'img-2'
    );
    expect(pending).toMatchObject({ status: 'error', error: expect.any(String) });
    // A part that already landed keeps its result: this seals, it does not undo.
    expect(landed).toMatchObject({ status: 'completed', imageUrl: '/images/img-2.png' });
  });
});
