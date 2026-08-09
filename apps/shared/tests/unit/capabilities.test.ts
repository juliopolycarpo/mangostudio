import { describe, expect, it } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import {
  ChatCapabilitiesQuerySchema,
  type ChatCapabilitiesResponse,
  ChatCapabilitiesResponseSchema,
} from '../../src/capabilities';

function makeResponse(overrides: Partial<ChatCapabilitiesResponse> = {}): ChatCapabilitiesResponse {
  return {
    chatId: 'chat-1',
    model: { modelId: 'gpt-test', provider: 'openai' },
    agent: { id: 'default', name: 'Default', kind: 'builtin' },
    tools: [
      {
        name: 'generate_image',
        title: 'Image generation',
        source: 'builtin',
        state: 'enabled',
        category: 'image',
      },
      {
        name: 'mcp__github__create_issue',
        title: 'create_issue',
        source: 'mcp',
        state: 'unavailable',
        reason: 'server-unavailable',
        serverSlug: 'github',
        serverName: 'GitHub',
      },
    ],
    mcpServers: [
      {
        slug: 'github',
        name: 'GitHub',
        state: 'unavailable',
        reason: 'server-unavailable',
        health: 'error',
        effectiveToolCount: 0,
      },
    ],
    skills: [
      {
        key: 'mango:changelog',
        slug: 'changelog',
        name: 'changelog',
        source: 'mango',
        state: 'enabled',
      },
    ],
    counts: { effectiveTools: 1, effectiveSkills: 1 },
    contextInfo: null,
    runtimeHash: 'abc123',
    ...overrides,
  };
}

describe('capabilities contracts', () => {
  it('accepts a full response projection', () => {
    expect(Value.Check(ChatCapabilitiesResponseSchema, makeResponse())).toBe(true);
  });

  it('accepts a context snapshot and every entry state', () => {
    const response = makeResponse({
      contextInfo: {
        estimatedInputTokens: 1200,
        contextLimit: 8000,
        estimatedUsageRatio: 0.15,
        mode: 'stateful',
        severity: 'normal',
      },
      skills: [
        {
          key: 'agents:notes',
          slug: 'notes',
          name: 'notes',
          source: 'agents',
          state: 'disabled',
          reason: 'skill-disabled',
        },
        {
          key: 'claude:notes',
          slug: 'notes',
          name: 'notes',
          source: 'claude',
          state: 'unavailable',
          reason: 'skill-shadowed',
        },
      ],
    });
    expect(Value.Check(ChatCapabilitiesResponseSchema, response)).toBe(true);
  });

  it('rejects unknown reason codes and states', () => {
    const badReason = makeResponse();
    (badReason.tools[0] as { reason?: string }).reason = 'because';
    expect(Value.Check(ChatCapabilitiesResponseSchema, badReason)).toBe(false);

    const badState = makeResponse();
    (badState.tools[0] as { state: string }).state = 'maybe';
    expect(Value.Check(ChatCapabilitiesResponseSchema, badState)).toBe(false);
  });

  it('validates composer override queries', () => {
    expect(Value.Check(ChatCapabilitiesQuerySchema, {})).toBe(true);
    expect(
      Value.Check(ChatCapabilitiesQuerySchema, {
        model: 'gpt-test',
        agentId: 'user:my-agent',
      })
    ).toBe(true);
    expect(Value.Check(ChatCapabilitiesQuerySchema, { agentId: 'Not A Slug' })).toBe(false);
  });
});
