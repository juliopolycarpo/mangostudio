import { describe, expect, it } from 'bun:test';

import type { MessagePart } from '@mangostudio/shared/types';

import { isToolOnlyRetryInProgress } from '../../../../src/modules/generation/application/turn-recovery';

const modelCall: MessagePart = { type: 'tool_call', toolCallId: 'call-1', name: 'read', args: {} };
const userCall: MessagePart = {
  type: 'tool_call',
  toolCallId: 'call-2',
  name: 'read',
  args: {},
  retryOf: 'call-1',
  initiatedBy: 'user',
};

describe('isToolOnlyRetryInProgress', () => {
  it('is false for a model turn, whose calls the model started', () => {
    expect(isToolOnlyRetryInProgress([modelCall])).toBe(false);
  });

  it('is true while a call the user started has no result', () => {
    expect(isToolOnlyRetryInProgress([modelCall, userCall])).toBe(true);
  });

  it('is false once every call the user started has a result', () => {
    const result: MessagePart = { type: 'tool_result', toolCallId: 'call-2', content: 'ok' };

    expect(isToolOnlyRetryInProgress([modelCall, userCall, result])).toBe(false);
  });
});
