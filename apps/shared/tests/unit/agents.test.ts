import { describe, expect, it } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import {
  AgentMarkdownPreviewResponseSchema,
  AgentProfileSchema,
  AgentProfileUpsertBodySchema,
  AgentProfileValidationError,
  BUILT_IN_AGENT_PROFILES,
  DeleteAgentProfileResponseSchema,
  parseAgentMarkdown,
} from '../../src/agents';

describe('agent contracts', () => {
  it('normalizes the built-in chat and default profiles', () => {
    expect(BUILT_IN_AGENT_PROFILES).toEqual([
      expect.objectContaining({
        id: 'chat',
        name: 'Chat',
        kind: 'builtin',
        role: 'primary',
        source: { type: 'builtin' },
      }),
      expect.objectContaining({
        id: 'default',
        name: 'Default',
        kind: 'builtin',
        role: 'both',
        source: { type: 'builtin' },
        subagentIds: ['explore'],
      }),
      expect.objectContaining({
        id: 'explore',
        name: 'Explore',
        kind: 'builtin',
        role: 'subagent',
        source: { type: 'builtin' },
      }),
    ]);

    for (const profile of BUILT_IN_AGENT_PROFILES) {
      expect(Value.Check(AgentProfileSchema, profile)).toBe(true);
    }
  });

  it('parses markdown frontmatter with array tools', () => {
    const profile = parseAgentMarkdown(
      `---
name: Research Agent
description: Finds relevant project context.
model: claude-sonnet-4-5
tools:
  - grep
  - read
role: both
subagents:
  - user:reviewer
---
Use the repository context before answering.
`,
      { id: 'user:research-agent', path: '/agents/research.md' }
    );

    expect(profile).toEqual({
      id: 'user:research-agent',
      name: 'Research Agent',
      description: 'Finds relevant project context.',
      kind: 'user',
      role: 'both',
      source: { type: 'markdown', path: '/agents/research.md' },
      systemPrompt: 'Use the repository context before answering.',
      model: 'claude-sonnet-4-5',
      toolNames: ['grep', 'read'],
      toolsEnabled: true,
      subagentIds: ['user:reviewer'],
      metadata: {},
    });
    expect(Value.Check(AgentProfileSchema, profile)).toBe(true);
  });

  it('parses comma-separated tools and maps subagent mode to role', () => {
    const profile = parseAgentMarkdown(
      `---
name: Reviewer
tools: grep, read, lsp
mode: subagent
---
Review the patch for correctness.
`,
      { id: 'user:reviewer' }
    );

    expect(profile.role).toBe('subagent');
    expect(profile.toolNames).toEqual(['grep', 'read', 'lsp']);
    expect(profile.toolsEnabled).toBe(true);
    expect(profile.systemPrompt).toBe('Review the patch for correctness.');
  });

  it('preserves unconsumed frontmatter fields as metadata', () => {
    const profile = parseAgentMarkdown(
      `---
name: Guarded Agent
permission: ask
color: mango
temperature: 0.2
---
Stay inside the allowed scope.
`,
      { id: 'user:guarded-agent' }
    );

    expect(profile.metadata).toEqual({
      permission: 'ask',
      color: 'mango',
      temperature: 0.2,
    });
  });

  it('rejects invalid ids, blank names, and invalid roles', () => {
    expect(() =>
      parseAgentMarkdown('---\nname: Valid\n---\nPrompt', { id: 'user:Invalid' })
    ).toThrow(AgentProfileValidationError);

    expect(() =>
      parseAgentMarkdown('---\nname:   \n---\nPrompt', { id: 'user:blank-name' })
    ).toThrow(AgentProfileValidationError);

    expect(() =>
      parseAgentMarkdown('---\nname: Valid\nrole: worker\n---\nPrompt', { id: 'user:bad-role' })
    ).toThrow(AgentProfileValidationError);
  });

  it('keeps markdown without frontmatter as the system prompt', () => {
    const profile = parseAgentMarkdown('Use the whole file as instructions.', {
      id: 'user:plain-agent',
    });

    expect(profile.name).toBe('Plain Agent');
    expect(profile.systemPrompt).toBe('Use the whole file as instructions.');
    expect(profile.toolNames).toEqual([]);
    expect(profile.toolsEnabled).toBe(false);
  });

  it('validates agent settings request and response contract shapes', () => {
    const body = {
      name: 'Researcher',
      description: 'Finds project context.',
      role: 'both',
      systemPrompt: 'Read first.',
      reasoningEffort: 'high',
      maxToolIterations: 1_000,
      toolNames: ['read_file'],
      toolsEnabled: true,
      subagentIds: ['user:reviewer'],
      metadata: { color: 'mango' },
    };
    const preview = {
      markdown: '---\nname: Researcher\n---\nRead first.',
      profile: {
        id: 'user:researcher',
        kind: 'user',
        source: { type: 'markdown', path: '/tmp/researcher.md' },
        ...body,
      },
    };

    expect(Value.Check(AgentProfileUpsertBodySchema, body)).toBe(true);
    expect(Value.Check(AgentMarkdownPreviewResponseSchema, preview)).toBe(true);
    expect(Value.Check(DeleteAgentProfileResponseSchema, { success: true })).toBe(true);
  });
});
