import { describe, expect, it } from 'bun:test';
import {
  type ContinuationEnvelope,
  computeSystemPromptHash,
  computeToolsetHash,
  createContinuationEnvelope,
  isDurableMode,
  parseContinuationEnvelope,
  serializeContinuationEnvelope,
  validateContinuationEnvelope,
} from '../../../../src/services/providers/core/continuation-envelope';
import {
  CONTINUATION_STRATEGIES,
  decideContinuation,
  decideTurnPersistence,
  getContinuationStrategy,
  isDurableEnvelope,
} from '../../../../src/services/providers/core/continuation-runtime';

const BASE_ENVELOPE: ContinuationEnvelope = {
  schemaVersion: 1,
  provider: 'gemini',
  mode: 'interactions',
  modelName: 'gemini-2.0-flash',
  systemPromptHash: 'abc123',
  toolsetHash: 'def456',
  cursor: 'interaction_xyz',
};

describe('parseContinuationEnvelope', () => {
  it('parses a valid envelope', () => {
    const raw = JSON.stringify(BASE_ENVELOPE);
    const result = parseContinuationEnvelope(raw);
    expect(result).toEqual(BASE_ENVELOPE);
  });

  it('returns null for null input', () => {
    expect(parseContinuationEnvelope(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(parseContinuationEnvelope(undefined)).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseContinuationEnvelope('not json {')).toBeNull();
  });

  it('returns null for wrong schemaVersion', () => {
    const raw = JSON.stringify({ ...BASE_ENVELOPE, schemaVersion: 2 });
    expect(parseContinuationEnvelope(raw)).toBeNull();
  });

  it('returns null for missing required fields', () => {
    const { provider: _, ...incomplete } = BASE_ENVELOPE;
    expect(parseContinuationEnvelope(JSON.stringify(incomplete))).toBeNull();
  });

  it('returns null for unknown mode strings', () => {
    const raw = JSON.stringify({ ...BASE_ENVELOPE, mode: 'legacy-mode' });
    expect(parseContinuationEnvelope(raw)).toBeNull();
  });

  it('returns null for durable mode without cursor', () => {
    const { cursor: _, ...withoutCursor } = BASE_ENVELOPE;
    expect(parseContinuationEnvelope(JSON.stringify(withoutCursor))).toBeNull();
  });

  it('returns null for responses mode without cursor', () => {
    const envelopeWithoutCursor = {
      schemaVersion: 1,
      provider: 'openai',
      mode: 'responses',
      modelName: 'gpt-4o',
      systemPromptHash: 'abc',
      toolsetHash: 'def',
    };
    expect(parseContinuationEnvelope(JSON.stringify(envelopeWithoutCursor))).toBeNull();
  });

  it('accepts stateless-loop without cursor', () => {
    const envelope = {
      schemaVersion: 1,
      provider: 'openai-compatible',
      mode: 'stateless-loop',
      modelName: 'deepseek-chat',
      systemPromptHash: 'none',
      toolsetHash: 'abc123',
    };
    const result = parseContinuationEnvelope(JSON.stringify(envelope));
    expect(result).not.toBeNull();
    expect(result?.mode).toBe('stateless-loop');
  });
});

describe('serializeContinuationEnvelope + parseContinuationEnvelope', () => {
  it('round-trips to identity', () => {
    const serialized = serializeContinuationEnvelope(BASE_ENVELOPE);
    const parsed = parseContinuationEnvelope(serialized);
    expect(parsed).toEqual(BASE_ENVELOPE);
  });
});

describe('validateContinuationEnvelope', () => {
  const current = {
    provider: 'gemini' as const,
    modelName: 'gemini-2.0-flash',
    systemPromptHash: 'abc123',
    toolsetHash: 'def456',
  };

  it('returns valid for matching envelope', () => {
    const result = validateContinuationEnvelope(BASE_ENVELOPE, current);
    expect(result).toEqual({ valid: true });
  });

  it('returns invalid for null envelope', () => {
    const result = validateContinuationEnvelope(null, current);
    expect(result.valid).toBe(false);
  });

  it('detects provider mismatch', () => {
    const envelope = { ...BASE_ENVELOPE, provider: 'openai' as const };
    const result = validateContinuationEnvelope(envelope, current);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('provider');
  });

  it('detects model mismatch', () => {
    const envelope = { ...BASE_ENVELOPE, modelName: 'gemini-2.5-pro' };
    const result = validateContinuationEnvelope(envelope, current);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('model');
  });

  it('detects systemPromptHash mismatch', () => {
    const envelope = { ...BASE_ENVELOPE, systemPromptHash: 'different' };
    const result = validateContinuationEnvelope(envelope, current);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('system');
  });

  it('detects toolsetHash mismatch', () => {
    const envelope = { ...BASE_ENVELOPE, toolsetHash: 'different' };
    const result = validateContinuationEnvelope(envelope, current);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('toolset');
  });

  it('detects agent id mismatch when current turn is agent-bound', () => {
    const envelope = { ...BASE_ENVELOPE, agentId: 'chat' as const };
    const result = validateContinuationEnvelope(envelope, {
      ...current,
      agentId: 'default',
    });

    expect(result.valid).toBe(false);
    expect(result.reasonCode).toBe('agent_changed');
  });

  it('detects agent runtime hash mismatch', () => {
    const envelope = { ...BASE_ENVELOPE, agentId: 'default' as const, agentRuntimeHash: 'old' };
    const result = validateContinuationEnvelope(envelope, {
      ...current,
      agentId: 'default',
      agentRuntimeHash: 'new',
    });

    expect(result.valid).toBe(false);
    expect(result.reasonCode).toBe('agent_runtime_changed');
  });
});

describe('computeSystemPromptHash', () => {
  it('is deterministic for the same input', () => {
    const hash1 = computeSystemPromptHash('You are a helpful assistant.');
    const hash2 = computeSystemPromptHash('You are a helpful assistant.');
    expect(hash1).toBe(hash2);
  });

  it('differs for different inputs', () => {
    const hash1 = computeSystemPromptHash('Prompt A');
    const hash2 = computeSystemPromptHash('Prompt B');
    expect(hash1).not.toBe(hash2);
  });

  it('returns "none" for undefined', () => {
    expect(computeSystemPromptHash(undefined)).toBe('none');
  });

  it('returns "none" for empty string', () => {
    expect(computeSystemPromptHash('')).toBe('none');
  });

  it('returns "none" for whitespace-only string', () => {
    expect(computeSystemPromptHash('   ')).toBe('none');
  });
});

describe('isDurableMode', () => {
  it('returns true for responses', () => {
    expect(isDurableMode('responses')).toBe(true);
  });

  it('returns true for interactions', () => {
    expect(isDurableMode('interactions')).toBe(true);
  });

  it('returns false for stateless-loop', () => {
    expect(isDurableMode('stateless-loop')).toBe(false);
  });
});

describe('computeToolsetHash', () => {
  it('is deterministic for the same input', () => {
    const tools = [{ name: 'tool_a', description: 'A tool', parameters: { type: 'object' } }];
    expect(computeToolsetHash(tools)).toBe(computeToolsetHash(tools));
  });

  it('is order-independent (sorted by name)', () => {
    const toolA = { name: 'a', description: 'A', parameters: {} };
    const toolB = { name: 'b', description: 'B', parameters: {} };
    expect(computeToolsetHash([toolA, toolB])).toBe(computeToolsetHash([toolB, toolA]));
  });
});

describe('getContinuationStrategy', () => {
  it('returns strategy for openai', () => {
    const s = getContinuationStrategy('openai');
    expect(s.provider).toBe('openai');
    expect(s.strategy).toBe('durable-cursor');
    expect(s.supportsDurableCursor).toBe(true);
    expect(s.durableMode).toBe('responses');
  });

  it('returns strategy for gemini', () => {
    const s = getContinuationStrategy('gemini');
    expect(s.provider).toBe('gemini');
    expect(s.strategy).toBe('durable-cursor');
    expect(s.supportsDurableCursor).toBe(true);
    expect(s.durableMode).toBe('interactions');
  });

  it('returns replay strategy for openai-compatible', () => {
    const s = getContinuationStrategy('openai-compatible');
    expect(s.provider).toBe('openai-compatible');
    expect(s.strategy).toBe('replay');
    expect(s.supportsDurableCursor).toBe(false);
    expect(s.durableMode).toBeNull();
  });

  it('returns strategy for anthropic', () => {
    const s = getContinuationStrategy('anthropic');
    expect(s.provider).toBe('anthropic');
    expect(s.strategy).toBe('turn-local');
    expect(s.supportsDurableCursor).toBe(false);
    expect(s.durableMode).toBeNull();
  });
});

describe('CONTINUATION_STRATEGIES', () => {
  it('covers all known provider types', () => {
    const keys = Object.keys(CONTINUATION_STRATEGIES);
    expect(keys).toContain('openai');
    expect(keys).toContain('gemini');
    expect(keys).toContain('openai-compatible');
    expect(keys).toContain('anthropic');
  });
});

describe('decideContinuation', () => {
  const baseContext = {
    modelName: 'gpt-4o',
    systemPromptHash: 'abc123',
    toolsetHash: 'def456',
  };

  it('returns start_replay when lastProviderState is null', () => {
    const decision = decideContinuation({
      lastProviderState: null,
      provider: 'openai',
      ...baseContext,
    });
    expect(decision.type).toBe('start_replay');
  });

  it('returns continue_with_cursor for valid openai envelope', () => {
    const envelope: ContinuationEnvelope = {
      schemaVersion: 1,
      provider: 'openai',
      mode: 'responses',
      modelName: 'gpt-4o',
      systemPromptHash: 'abc123',
      toolsetHash: 'def456',
      cursor: 'resp_123',
    };
    const decision = decideContinuation({
      lastProviderState: JSON.stringify(envelope),
      provider: 'openai',
      ...baseContext,
    });
    expect(decision.type).toBe('continue_with_cursor');
    if (decision.type === 'continue_with_cursor') {
      expect(decision.envelope.cursor).toBe('resp_123');
    }
  });

  it('returns degrade_to_replay on provider mismatch', () => {
    const envelope: ContinuationEnvelope = {
      schemaVersion: 1,
      provider: 'openai',
      mode: 'responses',
      modelName: 'gpt-4o',
      systemPromptHash: 'abc123',
      toolsetHash: 'def456',
      cursor: 'resp_123',
    };
    const decision = decideContinuation({
      lastProviderState: JSON.stringify(envelope),
      provider: 'gemini',
      ...baseContext,
    });
    expect(decision.type).toBe('degrade_to_replay');
    if (decision.type === 'degrade_to_replay') {
      expect(decision.previousMode).toBe('responses');
      expect(decision.reason).toContain('provider');
    }
  });

  it('returns degrade_to_replay on model mismatch', () => {
    const envelope: ContinuationEnvelope = {
      schemaVersion: 1,
      provider: 'openai',
      mode: 'responses',
      modelName: 'gpt-4o',
      systemPromptHash: 'abc123',
      toolsetHash: 'def456',
      cursor: 'resp_123',
    };
    const decision = decideContinuation({
      lastProviderState: JSON.stringify(envelope),
      provider: 'openai',
      modelName: 'gpt-3.5-turbo',
      systemPromptHash: 'abc123',
      toolsetHash: 'def456',
    });
    expect(decision.type).toBe('degrade_to_replay');
    if (decision.type === 'degrade_to_replay') {
      expect(decision.reason).toContain('model');
    }
  });

  it('returns degrade_to_replay for malformed envelope', () => {
    const decision = decideContinuation({
      lastProviderState: 'not-json',
      provider: 'openai',
      ...baseContext,
    });
    expect(decision.type).toBe('degrade_to_replay');
  });

  it('returns start_replay for stateless-loop envelope', () => {
    const envelope: ContinuationEnvelope = {
      schemaVersion: 1,
      provider: 'openai-compatible',
      mode: 'stateless-loop',
      modelName: 'deepseek-chat',
      systemPromptHash: 'abc123',
      toolsetHash: 'def456',
    };
    const decision = decideContinuation({
      lastProviderState: JSON.stringify(envelope),
      provider: 'openai-compatible',
      modelName: 'deepseek-chat',
      systemPromptHash: 'abc123',
      toolsetHash: 'def456',
    });
    expect(decision.type).toBe('start_replay');
  });

  it('returns continue_with_cursor for valid gemini envelope', () => {
    const envelope: ContinuationEnvelope = {
      schemaVersion: 1,
      provider: 'gemini',
      mode: 'interactions',
      modelName: 'gemini-2.0-flash',
      systemPromptHash: 'abc123',
      toolsetHash: 'def456',
      cursor: 'interaction_xyz',
    };
    const decision = decideContinuation({
      lastProviderState: JSON.stringify(envelope),
      provider: 'gemini',
      modelName: 'gemini-2.0-flash',
      systemPromptHash: 'abc123',
      toolsetHash: 'def456',
    });
    expect(decision.type).toBe('continue_with_cursor');
    if (decision.type === 'continue_with_cursor') {
      expect(decision.envelope.cursor).toBe('interaction_xyz');
    }
  });

  it('returns degrade_to_replay when gemini system prompt changes', () => {
    const envelope: ContinuationEnvelope = {
      schemaVersion: 1,
      provider: 'gemini',
      mode: 'interactions',
      modelName: 'gemini-2.0-flash',
      systemPromptHash: 'old_hash',
      toolsetHash: 'def456',
      cursor: 'interaction_xyz',
    };
    const decision = decideContinuation({
      lastProviderState: JSON.stringify(envelope),
      provider: 'gemini',
      modelName: 'gemini-2.0-flash',
      systemPromptHash: 'new_hash',
      toolsetHash: 'def456',
    });
    expect(decision.type).toBe('degrade_to_replay');
    if (decision.type === 'degrade_to_replay') {
      expect(decision.reason).toContain('system prompt');
    }
  });
});

describe('isDurableEnvelope', () => {
  it('returns true for valid openai responses cursor', () => {
    const envelope: ContinuationEnvelope = {
      schemaVersion: 1,
      provider: 'openai',
      mode: 'responses',
      modelName: 'gpt-4o',
      systemPromptHash: 'abc',
      toolsetHash: 'def',
      cursor: 'resp_123',
    };
    expect(isDurableEnvelope(envelope, 'openai')).toBe(true);
  });

  it('returns true for valid gemini interactions cursor', () => {
    const envelope: ContinuationEnvelope = {
      schemaVersion: 1,
      provider: 'gemini',
      mode: 'interactions',
      modelName: 'gemini-2.0-flash',
      systemPromptHash: 'abc',
      toolsetHash: 'def',
      cursor: 'interaction_xyz',
    };
    expect(isDurableEnvelope(envelope, 'gemini')).toBe(true);
  });

  it('returns false for stateless-loop', () => {
    const envelope: ContinuationEnvelope = {
      schemaVersion: 1,
      provider: 'openai-compatible',
      mode: 'stateless-loop',
      modelName: 'deepseek-chat',
      systemPromptHash: 'abc',
      toolsetHash: 'def',
    };
    expect(isDurableEnvelope(envelope, 'openai-compatible')).toBe(false);
  });

  it('returns false when provider does not match envelope', () => {
    const envelope: ContinuationEnvelope = {
      schemaVersion: 1,
      provider: 'openai',
      mode: 'responses',
      modelName: 'gpt-4o',
      systemPromptHash: 'abc',
      toolsetHash: 'def',
      cursor: 'resp_123',
    };
    expect(isDurableEnvelope(envelope, 'gemini')).toBe(false);
  });

  it('returns false for null envelope', () => {
    expect(isDurableEnvelope(null, 'openai')).toBe(false);
  });

  it('returns false for missing cursor', () => {
    const envelope = {
      schemaVersion: 1 as const,
      provider: 'openai' as const,
      mode: 'responses' as const,
      modelName: 'gpt-4o',
      systemPromptHash: 'abc',
      toolsetHash: 'def',
    };
    expect(isDurableEnvelope(envelope, 'openai')).toBe(false);
  });
});

describe('decideTurnPersistence', () => {
  it('returns null state for null providerState', () => {
    const result = decideTurnPersistence(null, 'openai');
    expect(result.envelope).toBeNull();
    expect(result.durableProviderState).toBeNull();
  });

  it('persists durable openai responses cursor', () => {
    const envelope: ContinuationEnvelope = {
      schemaVersion: 1,
      provider: 'openai',
      mode: 'responses',
      modelName: 'gpt-4o',
      systemPromptHash: 'abc',
      toolsetHash: 'def',
      cursor: 'resp_123',
    };
    const raw = serializeContinuationEnvelope(envelope);

    const result = decideTurnPersistence(raw, 'openai');
    expect(result.envelope?.cursor).toBe('resp_123');
    expect(result.durableProviderState).toBe(raw);
  });

  it('persists durable gemini interactions cursor', () => {
    const envelope: ContinuationEnvelope = {
      schemaVersion: 1,
      provider: 'gemini',
      mode: 'interactions',
      modelName: 'gemini-2.0-flash',
      systemPromptHash: 'abc',
      toolsetHash: 'def',
      cursor: 'interaction_xyz',
    };
    const raw = serializeContinuationEnvelope(envelope);

    const result = decideTurnPersistence(raw, 'gemini');
    expect(result.durableProviderState).toBe(raw);
  });

  it('does not persist stateless-loop envelope', () => {
    const envelope: ContinuationEnvelope = {
      schemaVersion: 1,
      provider: 'openai-compatible',
      mode: 'stateless-loop',
      modelName: 'deepseek-chat',
      systemPromptHash: 'abc',
      toolsetHash: 'def',
    };
    const raw = serializeContinuationEnvelope(envelope);

    const result = decideTurnPersistence(raw, 'openai-compatible');
    expect(result.envelope?.mode).toBe('stateless-loop');
    expect(result.durableProviderState).toBeNull();
  });

  it('does not persist when provider does not match envelope', () => {
    const envelope: ContinuationEnvelope = {
      schemaVersion: 1,
      provider: 'openai',
      mode: 'responses',
      modelName: 'gpt-4o',
      systemPromptHash: 'abc',
      toolsetHash: 'def',
      cursor: 'resp_123',
    };
    const raw = serializeContinuationEnvelope(envelope);

    const result = decideTurnPersistence(raw, 'gemini');
    expect(result.envelope?.provider).toBe('openai');
    expect(result.durableProviderState).toBeNull();
  });

  it('returns null state for malformed providerState', () => {
    const result = decideTurnPersistence('not-json', 'openai');
    expect(result.envelope).toBeNull();
    expect(result.durableProviderState).toBeNull();
  });
});

describe('decideContinuation provider switch + cursor recovery', () => {
  it('OpenAI -> Gemini: degrades to replay on first switch turn', () => {
    const openaiEnvelope: ContinuationEnvelope = {
      schemaVersion: 1,
      provider: 'openai',
      mode: 'responses',
      modelName: 'gpt-4o',
      systemPromptHash: 'sys_abc',
      toolsetHash: 'tools_def',
      cursor: 'resp_abc123',
    };

    const decision = decideContinuation({
      lastProviderState: serializeContinuationEnvelope(openaiEnvelope),
      provider: 'gemini',
      modelName: 'gemini-2.0-flash',
      systemPromptHash: 'sys_abc',
      toolsetHash: 'tools_def',
    });

    expect(decision.type).toBe('degrade_to_replay');
    if (decision.type === 'degrade_to_replay') {
      expect(decision.previousMode).toBe('responses');
    }
  });

  it('OpenAI -> Gemini: second turn after switch uses Gemini cursor', () => {
    const geminiEnvelope: ContinuationEnvelope = {
      schemaVersion: 1,
      provider: 'gemini',
      mode: 'interactions',
      modelName: 'gemini-2.0-flash',
      systemPromptHash: 'sys_abc',
      toolsetHash: 'tools_def',
      cursor: 'interaction_xyz',
    };

    const decision = decideContinuation({
      lastProviderState: serializeContinuationEnvelope(geminiEnvelope),
      provider: 'gemini',
      modelName: 'gemini-2.0-flash',
      systemPromptHash: 'sys_abc',
      toolsetHash: 'tools_def',
    });

    expect(decision.type).toBe('continue_with_cursor');
    if (decision.type === 'continue_with_cursor') {
      expect(decision.envelope.cursor).toBe('interaction_xyz');
    }
  });

  it('openai-compatible: stateless-loop envelope from prior turn never carries forward', () => {
    const statelessEnvelope: ContinuationEnvelope = {
      schemaVersion: 1,
      provider: 'openai-compatible',
      mode: 'stateless-loop',
      modelName: 'deepseek-chat',
      systemPromptHash: 'sys_none',
      toolsetHash: 'tools_def',
    };

    const decision = decideContinuation({
      lastProviderState: serializeContinuationEnvelope(statelessEnvelope),
      provider: 'openai-compatible',
      modelName: 'deepseek-chat',
      systemPromptHash: 'sys_none',
      toolsetHash: 'tools_def',
    });

    expect(decision.type).toBe('start_replay');
  });

  it('openai-compatible: turn-local stateless-loop state must never persist as durable', () => {
    const envelope: ContinuationEnvelope = {
      schemaVersion: 1,
      provider: 'openai-compatible',
      mode: 'stateless-loop',
      modelName: 'deepseek-chat',
      systemPromptHash: 'sys_none',
      toolsetHash: 'tools_def',
    };

    const persisted = decideTurnPersistence(
      serializeContinuationEnvelope(envelope),
      'openai-compatible'
    );

    expect(persisted.durableProviderState).toBeNull();
  });

  it('openai-compatible: stateless-loop with mismatched toolset degrades to replay', () => {
    const envelope: ContinuationEnvelope = {
      schemaVersion: 1,
      provider: 'openai-compatible',
      mode: 'stateless-loop',
      modelName: 'deepseek-chat',
      systemPromptHash: 'sys_none',
      toolsetHash: 'old_tools',
    };

    const decision = decideContinuation({
      lastProviderState: serializeContinuationEnvelope(envelope),
      provider: 'openai-compatible',
      modelName: 'deepseek-chat',
      systemPromptHash: 'sys_none',
      toolsetHash: 'new_tools',
    });

    expect(decision.type).toBe('degrade_to_replay');
    if (decision.type === 'degrade_to_replay') {
      expect(decision.previousMode).toBe('stateless-loop');
      expect(decision.reason).toContain('toolset');
    }
  });
});

describe('continuationSystemPrompt hash exclusion (todo prompt injection)', () => {
  const basePrompt = 'You are a helpful agent.';
  const todoSection = '<current-todo-list>\n- [>] step one\n</current-todo-list>';

  it('keeps the envelope hash stable when only the injected todo section changes', () => {
    const turnOne = createContinuationEnvelope('gemini', 'interactions', {
      modelName: 'gemini-2.0-flash',
      systemPrompt: basePrompt,
      continuationSystemPrompt: basePrompt,
    });
    const turnTwo = createContinuationEnvelope('gemini', 'interactions', {
      modelName: 'gemini-2.0-flash',
      systemPrompt: `${basePrompt}\n\n${todoSection}`,
      continuationSystemPrompt: basePrompt,
    });

    expect(turnOne.systemPromptHash).toBe(turnTwo.systemPromptHash);
    expect(turnOne.systemPromptHash).toBe(computeSystemPromptHash(basePrompt));
  });

  it('continues with the cursor across turns whose only difference is the todo section', () => {
    const envelope = createContinuationEnvelope(
      'gemini',
      'interactions',
      {
        modelName: 'gemini-2.0-flash',
        systemPrompt: `${basePrompt}\n\n${todoSection}`,
        continuationSystemPrompt: basePrompt,
      },
      'interaction_xyz'
    );

    const decision = decideContinuation({
      lastProviderState: serializeContinuationEnvelope(envelope),
      provider: 'gemini',
      modelName: 'gemini-2.0-flash',
      systemPromptHash: computeSystemPromptHash(basePrompt),
      toolsetHash: computeToolsetHash([]),
    });

    expect(decision.type).toBe('continue_with_cursor');
  });

  it('falls back to hashing the full system prompt when no base is provided', () => {
    const envelope = createContinuationEnvelope('anthropic', 'stateless-loop', {
      modelName: 'claude-sonnet-5',
      systemPrompt: basePrompt,
    });

    expect(envelope.systemPromptHash).toBe(computeSystemPromptHash(basePrompt));
  });
});
