import { describe, expect, it } from 'bun:test';
import { AgentSettingsError } from '../../../../src/modules/agents/domain/agent-profile';
import {
  parseAgentMarkdownProfile,
  serializeAgentMarkdown,
} from '../../../../src/modules/agents/application/agent-markdown-parser';

describe('agent markdown parser', () => {
  it('parses compatible frontmatter and preserves markdown body as system prompt', () => {
    const profile = parseAgentMarkdownProfile(
      `---
name: Researcher
description: Finds context.
role: both
tools:
  - read_file
  - list_directory
---
Use repository context.
`,
      { id: 'user:researcher', path: '/tmp/researcher.md' }
    );

    expect(profile).toMatchObject({
      id: 'user:researcher',
      name: 'Researcher',
      role: 'both',
      source: { type: 'markdown', path: '/tmp/researcher.md' },
      systemPrompt: 'Use repository context.',
      toolNames: ['read_file', 'list_directory'],
    });
  });

  it('maps validation failures to agent settings errors', () => {
    expect(() =>
      parseAgentMarkdownProfile('---\nname: Bad\nrole: worker\n---\nPrompt', {
        id: 'user:bad-role',
      })
    ).toThrow(AgentSettingsError);
  });

  it('serializes a profile into parseable markdown', () => {
    const markdown = serializeAgentMarkdown({
      id: 'user:writer',
      name: 'Writer',
      description: 'Drafts release notes.',
      kind: 'user',
      role: 'primary',
      source: { type: 'markdown', path: '/tmp/writer.md' },
      systemPrompt: 'Write clearly.',
      model: 'current_model',
      toolNames: ['read_file'],
      toolsEnabled: true,
      subagentIds: [],
      metadata: { color: 'mango' },
    });

    const parsed = parseAgentMarkdownProfile(markdown, { id: 'user:writer' });

    expect(parsed).toMatchObject({
      name: 'Writer',
      description: 'Drafts release notes.',
      model: 'current_model',
      systemPrompt: 'Write clearly.',
      metadata: { color: 'mango' },
    });
  });
});
