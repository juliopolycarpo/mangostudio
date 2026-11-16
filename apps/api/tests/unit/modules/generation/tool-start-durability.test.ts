/**
 * Which tool-progress items record a call starting that the hub must not run a
 * second time after a power loss. Only those checkpoints are committed durably;
 * anything broader would bring back an fsync for every checkpoint of a turn.
 */
import { describe, expect, it } from 'bun:test';

import type { ToolExecutionSnapshot } from '@mangostudio/shared/tool-executions';

import type { ToolExecutionProgressItem } from '../../../../src/modules/generation/application/standard-tool-execution';
import { recordsIrreversibleToolStart } from '../../../../src/modules/generation/application/stream-text-turn-helpers';

const snapshot = (status: ToolExecutionSnapshot['status']): ToolExecutionSnapshot => ({
  status,
  source: 'builtin',
  queuedAt: 1,
});

const transition = (
  name: string,
  status: ToolExecutionSnapshot['status']
): ToolExecutionProgressItem => ({
  kind: 'event',
  event: { type: 'tool_execution', callId: 'call-1', name, execution: snapshot(status) },
});

describe('recordsIrreversibleToolStart', () => {
  it.each([
    ['a shell command', 'run_shell'],
    ['a file write', 'write_file'],
    ['an MCP tool', 'mcp__server__do_thing'],
    ['a delegation', 'delegate_to_agent'],
    ['an image generation', 'generate_image'],
  ])('is true when %s moves to running', (_label, name) => {
    expect(recordsIrreversibleToolStart(transition(name, 'running'))).toBe(true);
  });

  it.each(['read_file', 'grep', 'glob', 'list_directory', 'skill', 'get_current_datetime'])(
    'is false when the read-only tool %s moves to running',
    (name) => {
      expect(recordsIrreversibleToolStart(transition(name, 'running'))).toBe(false);
    }
  );

  it.each(['queued', 'awaiting_user', 'succeeded', 'failed', 'cancelled'] as const)(
    'is false for a mutating tool in the %s state, since only the start is the marker',
    (status) => {
      expect(recordsIrreversibleToolStart(transition('run_shell', status))).toBe(false);
    }
  );

  it('is false for progress that is not a lifecycle transition', () => {
    const elicitation: ToolExecutionProgressItem = {
      kind: 'event',
      event: {
        type: 'mcp_elicitation',
        part: {
          type: 'mcp_elicitation',
          elicitationId: 'e1',
          toolCallId: 'call-1',
          serverSlug: 'srv',
          message: 'Confirm?',
          fields: [],
          status: 'pending',
        },
      },
    };

    expect(recordsIrreversibleToolStart(elicitation)).toBe(false);
  });
});
