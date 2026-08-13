import { describe, expect, it } from 'bun:test';
import Value from 'typebox/value';
import {
  ResumeInterruptedTurnSchema,
  TURN_RECOVERY_MAX_RETRY_CALLS,
  TurnCheckpointPartSchema,
} from '../../src/turn-recovery';

describe('turn recovery contracts', () => {
  it('accepts bounded checkpoint metadata', () => {
    expect(
      Value.Check(TurnCheckpointPartSchema, {
        type: 'turn_checkpoint',
        version: 1,
        turnId: 'turn-1',
        status: 'interrupted',
        reasonCode: 'server_restart',
        sequence: 3,
        startedAt: 1,
        checkpointedAt: 2,
        provider: 'openai',
        modelName: 'gpt-test',
        agentId: 'default',
        lastAssistantText: 'partial',
        todoSnapshot: [],
        completedCalls: [],
        incompleteCalls: [],
      })
    ).toBe(true);
  });

  it('rejects unknown reasons and oversized retry selections', () => {
    expect(
      Value.Check(ResumeInterruptedTurnSchema, {
        messageId: 'turn-1',
        requestId: 'request-1',
        retryCallIds: Array.from(
          { length: TURN_RECOVERY_MAX_RETRY_CALLS + 1 },
          (_, index) => `call-${index}`
        ),
      })
    ).toBe(false);
    expect(
      Value.Check(TurnCheckpointPartSchema, {
        type: 'turn_checkpoint',
        version: 1,
        turnId: 'turn-1',
        status: 'interrupted',
        reasonCode: 'made_up',
        sequence: 1,
        startedAt: 1,
        checkpointedAt: 2,
        provider: 'openai',
        modelName: 'gpt-test',
        agentId: 'default',
        lastAssistantText: '',
        todoSnapshot: [],
        completedCalls: [],
        incompleteCalls: [],
      })
    ).toBe(false);
  });
});
