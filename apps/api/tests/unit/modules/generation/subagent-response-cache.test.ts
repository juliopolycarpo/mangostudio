import { describe, expect, it } from 'bun:test';
import type { AgentId } from '@mangostudio/shared/agents';
import type { SubagentRunResult } from '../../../../src/modules/generation/application/subagent-runner';
import {
  clearSubagentCache,
  getSubagentCachedEntry,
  recordSubagentResult,
  recordSubagentStatus,
  recordSubagentText,
} from '../../../../src/modules/generation/application/subagent-response-cache';

describe('subagent-response-cache', () => {
  it('records partial text deltas and final results for a call id', () => {
    clearSubagentCache();
    const callId = 'delegate-1';
    const agentId = 'user:explorer' as AgentId;
    recordSubagentText(callId, agentId, 'Hello');
    recordSubagentText(callId, agentId, ' world');
    recordSubagentStatus(callId, agentId, 'Explore', 'completed');

    const entryBefore = getSubagentCachedEntry(callId);
    expect(entryBefore?.callId).toBe(callId);
    expect(entryBefore?.agentId).toBe(agentId);
    expect(entryBefore?.status).toBe('completed');
    expect(entryBefore?.partialText).toBe('Hello world');

    const result: SubagentRunResult = {
      agentId,
      agentName: 'Explore',
      status: 'completed',
      summary: 'Final summary.',
      messages: [{ role: 'assistant', text: 'Final summary.' }],
      toolCallCount: 0,
      tools: [],
      durationMs: 1,
      trace: {
        type: 'subagent_trace',
        toolCallId: callId,
        agentId,
        agentName: 'Explore',
        status: 'completed',
        summary: 'Final summary.',
        toolCallCount: 0,
        lastMessage: 'Final summary.',
        messages: [{ role: 'assistant', text: 'Final summary.' }],
        tools: [],
      },
    };
    recordSubagentResult(callId, result);

    const entryAfter = getSubagentCachedEntry(callId);
    expect(entryAfter?.result?.summary).toBe('Final summary.');
    expect(entryAfter?.partialText).toBe('Hello world');
  });

  it('clamps partial text to a bounded size', () => {
    clearSubagentCache();
    const callId = 'delegate-2';
    const agentId = 'user:explorer' as AgentId;
    const large = 'x'.repeat(100_000);
    recordSubagentText(callId, agentId, large);

    const entry = getSubagentCachedEntry(callId);
    expect(entry?.partialText?.length).toBeGreaterThan(0);
    expect(entry?.partialText?.length ?? 0).toBeLessThanOrEqual(30_000);
  });

  it('ignores empty call ids', () => {
    clearSubagentCache();
    const agentId = 'user:explorer' as AgentId;
    recordSubagentText('   ', agentId, 'x');
    expect(getSubagentCachedEntry('   ')).toBeUndefined();
  });
});
