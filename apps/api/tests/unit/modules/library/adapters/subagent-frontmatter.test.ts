import { describe, expect, it } from 'bun:test';
import { parse as parseToml } from 'smol-toml';
import { createSubagentAdapter } from '../../../../../src/modules/library/application/adapters/subagent-frontmatter';

describe('subagent frontmatter adapters', () => {
  it('reports Claude-only fields when normalizing same-format Markdown for Cursor', async () => {
    const adapter = createSubagentAdapter('markdown-frontmatter', 'markdown-frontmatter');
    const result = await adapter.adapt({
      content:
        '---\nname: "reviewer"\ndescription: "Reviews changes"\ntools: "Read, Grep"\npermissionMode: "plan"\n---\n\nReview the diff.\n',
      kind: 'subagent',
      from: 'markdown-frontmatter',
      to: 'markdown-frontmatter',
      resourceKey: 'subagent:reviewer',
      sourceLocationId: 'claude-agents',
      targetLocationId: 'cursor-agents',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.content).not.toContain('tools:');
    expect(result.content).not.toContain('permissionMode:');
    expect(result.notes.map((note) => note.field)).toEqual(['permissionMode', 'tools']);
  });

  it('normalizes Claude Markdown into Codex TOML and reports unsupported fields once', async () => {
    const adapter = createSubagentAdapter('markdown-frontmatter', 'toml-agent');
    const result = await adapter.adapt({
      content: `---
name: "reviewer"
description: "Reviews changes"
model: "sonnet"
tools:
  - "Read"
  - "Grep"
permissionMode: "plan"
---

Review the diff.
`,
      kind: 'subagent',
      from: 'markdown-frontmatter',
      to: 'toml-agent',
      resourceKey: 'subagent:reviewer',
      sourceLocationId: 'claude-agents',
      targetLocationId: 'codex-agents',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(parseToml(result.content)).toEqual({
      name: 'reviewer',
      description: 'Reviews changes',
      model: 'sonnet',
      developer_instructions: 'Review the diff.\n',
    });
    expect(result.notes.map((note) => note.field)).toEqual(['permissionMode', 'tools']);
  });

  it('renders a Cursor-compatible Markdown descriptor from Codex TOML', async () => {
    const adapter = createSubagentAdapter('toml-agent', 'markdown-frontmatter');
    const result = await adapter.adapt({
      content:
        'name = "reviewer"\ndescription = "Reviews changes"\nmodel = "gpt-5"\ndeveloper_instructions = "Review carefully.\\n"\nsandbox_mode = "read-only"\n',
      kind: 'subagent',
      from: 'toml-agent',
      to: 'markdown-frontmatter',
      resourceKey: 'subagent:reviewer',
      sourceLocationId: 'codex-agents',
      targetLocationId: 'cursor-agents',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.content).toContain('name: "reviewer"');
    expect(result.content).toContain('description: "Reviews changes"');
    expect(result.content).toContain('model: "gpt-5"');
    expect(result.content).toEndWith('Review carefully.\n');
    expect(result.notes.map((note) => note.field)).toEqual(['sandbox_mode']);
  });

  it('rejects invalid source framing without producing partial output', async () => {
    const adapter = createSubagentAdapter('markdown-frontmatter', 'toml-agent');
    const result = await adapter.adapt({
      content: '# Missing frontmatter',
      kind: 'subagent',
      from: 'markdown-frontmatter',
      to: 'toml-agent',
      resourceKey: 'subagent:broken',
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-source' } });
    expect('content' in result).toBe(false);
  });

  it('rejects missing required source metadata instead of inventing identity fields', async () => {
    const adapter = createSubagentAdapter('markdown-frontmatter', 'toml-agent');
    const result = await adapter.adapt({
      content: '---\nname: "reviewer"\n---\n\nReview the diff.\n',
      kind: 'subagent',
      from: 'markdown-frontmatter',
      to: 'toml-agent',
      resourceKey: 'subagent:reviewer',
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid-source', message: expect.stringContaining('description') },
    });
    expect('content' in result).toBe(false);
  });
});
