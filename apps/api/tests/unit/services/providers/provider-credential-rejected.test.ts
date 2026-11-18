/**
 * A provider that rejects a connector's key (HTTP 401 or 403) must surface one
 * shared typed error from every adapter. Before this, Anthropic, Gemini and the
 * Chat Completions adapters folded the rejection into `turn_error` text, and the
 * OpenAI Responses adapter threw the SDK's own error, so no caller could tell a
 * revoked key from any other provider failure.
 */
import { describe, expect, it } from 'bun:test';

import type { AgentEvent, AgentTurnRequest } from '../../../../src/services/providers/types';
import {
  KEY_REJECTING_PROVIDER_TYPES,
  KeyRejectingProviderFake,
  type KeyRejectingProviderType,
  UPSTREAM_REJECTION_TEXT,
} from '../../../support/providers/key-rejecting-providers';

const CREDENTIAL_REJECTED_CODE = 'PROVIDER_CREDENTIAL_REJECTED';
const REJECTION_STATUSES = [401, 403] as const;

function turnRequest(): AgentTurnRequest {
  return {
    userId: 'user-credential-rejected',
    modelName: 'test-model',
    history: [],
    prompt: 'Hello',
    generationConfig: { thinkingEnabled: false, reasoningEffort: 'medium' },
  };
}

interface DrainedTurn {
  readonly events: AgentEvent[];
  readonly thrown: unknown;
}

/** Drains a turn, keeping both what it yielded and what it threw. */
async function drain(source: AsyncIterable<AgentEvent>): Promise<DrainedTurn> {
  const events: AgentEvent[] = [];
  try {
    for await (const event of source) events.push(event);
  } catch (thrown) {
    return { events, thrown };
  }
  return { events, thrown: undefined };
}

function describeOutcome(turn: DrainedTurn): string {
  const turnError = turn.events.find((event) => event.type === 'turn_error');
  if (turnError?.type === 'turn_error') return `turn_error event "${turnError.error}"`;
  if (turn.thrown instanceof Error) {
    const code = (turn.thrown as { code?: unknown }).code;
    return `thrown ${turn.thrown.name} (code ${String(code)}): "${turn.thrown.message}"`;
  }
  return `events [${turn.events.map((event) => event.type).join(', ')}]`;
}

describe.each(KEY_REJECTING_PROVIDER_TYPES)('%s adapter on a rejected key', (providerType) => {
  it.each(REJECTION_STATUSES)(
    'throws the shared credential-rejected error on HTTP %d',
    async (status) => {
      const fake = new KeyRejectingProviderFake(providerType, status);

      const turn = await drain(fake.streamAgentTurn(turnRequest()));

      const thrown = turn.thrown as
        { code?: unknown; provider?: unknown; status?: unknown } | undefined;
      expect(
        thrown?.code,
        `(${providerType} agent turn, HTTP ${status}): expected thrown error with code ${CREDENTIAL_REJECTED_CODE} | received ${describeOutcome(turn)}`
      ).toBe(CREDENTIAL_REJECTED_CODE);
      expect(thrown?.provider).toBe(providerType);
      expect(thrown?.status).toBe(status);
      expect(
        fake.requestCount,
        `(${providerType} fake): expected the SDK to reach the fake once`
      ).toBeGreaterThan(0);
    }
  );

  it.each(REJECTION_STATUSES)(
    'does not forward the upstream message on HTTP %d',
    async (status) => {
      const fake = new KeyRejectingProviderFake(providerType, status);

      const turn = await drain(fake.streamAgentTurn(turnRequest()));

      const message = turn.thrown instanceof Error ? turn.thrown.message : describeOutcome(turn);
      expect(
        message,
        `(${providerType} HTTP ${status} message): expected no upstream text, which can echo part of the key | received "${message}"`
      ).not.toContain(UPSTREAM_REJECTION_TEXT);
      expect(
        turn.thrown,
        `(${providerType} HTTP ${status}): expected a thrown error`
      ).toBeInstanceOf(Error);
      expect((turn.thrown as Error).message).toContain('Settings');
    }
  );

  it('yields nothing before the rejection', async () => {
    const fake = new KeyRejectingProviderFake(providerType, 401);

    const turn = await drain(fake.streamAgentTurn(turnRequest()));

    expect(
      turn.events.map((event) => event.type),
      `(${providerType} events before the rejection): expected none | received ${describeOutcome(turn)}`
    ).toEqual([]);
  });
});

describe('rejections that are not about the credential', () => {
  const NOT_A_CREDENTIAL_PROBLEM: ReadonlyArray<KeyRejectingProviderType> = [
    'openai',
    'anthropic',
    'deepseek',
    'openai-compatible',
  ];

  it.each(NOT_A_CREDENTIAL_PROBLEM)(
    '%s keeps HTTP 500 out of the credential-rejected error',
    async (providerType) => {
      const fake = new KeyRejectingProviderFake(providerType, 500);

      const turn = await drain(fake.streamAgentTurn(turnRequest()));

      const code = (turn.thrown as { code?: unknown } | undefined)?.code;
      expect(
        code,
        `(${providerType} agent turn, HTTP 500): expected anything but ${CREDENTIAL_REJECTED_CODE} | received ${describeOutcome(turn)}`
      ).not.toBe(CREDENTIAL_REJECTED_CODE);
    }
  );
});
