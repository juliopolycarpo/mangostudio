/**
 * Maps raw Anthropic Messages stream events into canonical AgentEvents.
 *
 * Owns the per-turn tool-call bookkeeping: each tool_use content block is keyed
 * by its stream index so argument deltas and the stop event resolve back to a
 * stable call id and accumulated argument string.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { AgentEvent } from '../types';
import { isToolUseBlock, narrowDelta } from './normalizers';

type StreamEvent = Anthropic.MessageStreamEvent;
type BlockStartEvent = Extract<StreamEvent, { type: 'content_block_start' }>;
type BlockDeltaEvent = Extract<StreamEvent, { type: 'content_block_delta' }>;
type BlockStopEvent = Extract<StreamEvent, { type: 'content_block_stop' }>;

interface PendingToolBlock {
  callId: string;
  name: string;
  inputStr: string;
}

type BlockIndex = Map<number, PendingToolBlock>;

export interface AnthropicStreamAccumulator {
  /** Maps one raw Messages stream event into zero or more AgentEvents. */
  mapEvent(event: StreamEvent): AgentEvent[];
}

/** Builds an accumulator for a single Anthropic agentic stream. */
// Usage: const accumulator = createAnthropicStreamAccumulator();
export function createAnthropicStreamAccumulator(): AnthropicStreamAccumulator {
  const blockByIndex: BlockIndex = new Map();

  return {
    mapEvent(event) {
      switch (event.type) {
        case 'content_block_start':
          return mapBlockStart(event, blockByIndex);
        case 'content_block_delta':
          return mapBlockDelta(event, blockByIndex);
        case 'content_block_stop':
          return mapBlockStop(event, blockByIndex);
        default:
          return [];
      }
    },
  };
}

function mapBlockStart(event: BlockStartEvent, blockByIndex: BlockIndex): AgentEvent[] {
  if (!isToolUseBlock(event.content_block)) return [];
  const callId = event.content_block.id || `tu_${Date.now()}_${event.index}`;
  const name = event.content_block.name;
  blockByIndex.set(event.index, { callId, name, inputStr: '' });
  return [{ type: 'tool_call_started', callId, name }];
}

function mapBlockDelta(event: BlockDeltaEvent, blockByIndex: BlockIndex): AgentEvent[] {
  const delta = narrowDelta(event.delta);
  if (delta.kind === 'thinking') return [{ type: 'reasoning_delta', text: delta.thinking }];
  if (delta.kind === 'text') return [{ type: 'assistant_text_delta', text: delta.text }];
  if (delta.kind !== 'input_json') return [];

  const block = blockByIndex.get(event.index);
  if (!block) return [];
  block.inputStr += delta.partial_json;
  return [{ type: 'tool_call_arguments_delta', callId: block.callId, delta: delta.partial_json }];
}

function mapBlockStop(event: BlockStopEvent, blockByIndex: BlockIndex): AgentEvent[] {
  const block = blockByIndex.get(event.index);
  if (!block) return [];
  blockByIndex.delete(event.index);
  return [
    {
      type: 'tool_call_completed',
      callId: block.callId,
      name: block.name,
      arguments: block.inputStr,
    },
  ];
}
