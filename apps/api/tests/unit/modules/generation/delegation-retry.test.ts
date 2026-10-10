import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { DELEGATION_MAX_RETRIES } from '@mangostudio/shared/generation';
import { ensureDelegationResult } from '../../../../src/modules/generation/application/delegation-retry';
import { clearSubagentCache } from '../../../../src/modules/generation/application/subagent-response-cache';
import type {
  DelegateToSubagentRequest,
  SubagentRunResult,
} from '../../../../src/modules/generation/application/subagent-runner';

class FakeDelegationExecutor {
  readonly requests: DelegateToSubagentRequest[] = [];

  constructor(private readonly failuresBeforeSuccess: number) {}

  execute = (callId: string, request: DelegateToSubagentRequest): Promise<SubagentRunResult> => {
    this.requests.push(request);
    if (this.requests.length <= this.failuresBeforeSuccess) {
      return Promise.reject(new Error('Transient delegation failure'));
    }
    const summary = 'Delegation completed.';
    return Promise.resolve({
      agentId: request.agentId,
      agentName: 'Explore',
      status: 'completed',
      summary,
      messages: [{ role: 'assistant', text: summary }],
      toolCallCount: 0,
      tools: [],
      durationMs: 1,
      trace: {
        type: 'subagent_trace',
        toolCallId: callId,
        agentId: request.agentId,
        agentName: 'Explore',
        status: 'completed',
        summary,
        toolCallCount: 0,
        lastMessage: summary,
        messages: [{ role: 'assistant', text: summary }],
        tools: [],
      },
    });
  };
}

class FailingDelegationExecutor extends FakeDelegationExecutor {
  constructor() {
    super(Number.POSITIVE_INFINITY);
  }
}

const REQUEST: DelegateToSubagentRequest = {
  agentId: 'explore',
  task: 'Inspect the shared boundary.',
  expectedOutput: 'A concise summary.',
};

beforeEach(clearSubagentCache);
afterEach(clearSubagentCache);

describe('delegation retry with bounded generation limits', () => {
  it('returns a valid first response and keeps the original request', async () => {
    const fake = new FakeDelegationExecutor(0);
    const result = await ensureDelegationResult('first-response', REQUEST, {
      timeoutMs: 1_000,
      executeDelegation: fake.execute,
    });

    expect(fake.requests).toEqual([REQUEST]);
    expect(fake.requests[0]).toBe(REQUEST);
    expect(result.status).toBe('completed');
    expect(result.summary).toBe('Delegation completed.');
    expect(result.trace.events).toEqual([
      { event: 'response_attempt', attempt: 1, detail: 'call=first-response attempt=1' },
    ]);
  });

  it('recovers on the last permitted attempt without losing trace events', async () => {
    const fake = new FakeDelegationExecutor(DELEGATION_MAX_RETRIES);
    const result = await ensureDelegationResult('last-response', REQUEST, {
      timeoutMs: 1_000,
      executeDelegation: fake.execute,
    });

    expect(fake.requests.length).toBe(1 + DELEGATION_MAX_RETRIES);
    expect(fake.requests[0]).toBe(REQUEST);
    expect(fake.requests[1]?.expectedOutput).toContain('Always end with a non-empty');
    expect(result.status).toBe('completed');
    expect(result.summary).toBe('Delegation completed.');
    expect(
      result.trace.events
        ?.filter((event) => event.event === 'response_attempt')
        .map((event) => event.attempt)
    ).toEqual([1, 2, 3, 4]);
  });

  it('retains the failure fallback after the same retry limit', async () => {
    const fake = new FailingDelegationExecutor();
    const result = await ensureDelegationResult('failed-response', REQUEST, {
      timeoutMs: 1_000,
      executeDelegation: fake.execute,
    });

    expect(fake.requests.length).toBe(1 + DELEGATION_MAX_RETRIES);
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('Subagent failed to produce a final response.');
    expect(result.summary).toContain('Transient delegation failure');
    expect(result.trace.events?.at(-1)?.event).toBe('response_fallback');
  });
});
