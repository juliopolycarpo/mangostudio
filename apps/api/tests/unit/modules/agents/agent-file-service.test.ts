import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfigForTest } from '../../../../src/lib/config';
import {
  createMarkdownAgent,
  deleteMarkdownAgent,
  listMarkdownAgentProfiles,
  previewAgentMarkdown,
  readMarkdownAgent,
  writeMarkdownAgent,
} from '../../../../src/modules/agents/application/agent-file-service';
import { AgentSettingsError } from '../../../../src/modules/agents/domain/agent-profile';

let agentsDir: string;

beforeEach(() => {
  agentsDir = mkdtempSync(join(tmpdir(), 'mango-agent-files-'));
  loadConfigForTest({ agents: { dir: agentsDir } });
});

afterEach(() => {
  rmSync(agentsDir, { recursive: true, force: true });
});

describe('agent file service', () => {
  it('creates, reads, lists, and deletes markdown-backed agents', () => {
    const profile = createMarkdownAgent({
      id: 'user:researcher',
      name: 'Researcher',
      description: 'Finds project context.',
      kind: 'user',
      role: 'both',
      source: { type: 'markdown' },
      systemPrompt: 'Search before answering.',
      toolNames: ['read_file'],
      toolsEnabled: true,
      subagentIds: [],
      metadata: {},
    });

    const filePath = join(agentsDir, 'researcher.md');

    expect(existsSync(filePath)).toBe(true);
    expect(profile.source).toEqual({ type: 'markdown', path: filePath });
    expect(readMarkdownAgent('user:researcher').profile.systemPrompt).toBe(
      'Search before answering.'
    );
    expect(listMarkdownAgentProfiles().map((agent) => agent.id)).toEqual(['user:researcher']);

    deleteMarkdownAgent('user:researcher');
    expect(existsSync(filePath)).toBe(false);
  });

  it('rejects duplicate agents and unsafe paths', () => {
    writeFileSync(join(agentsDir, 'researcher.md'), 'Prompt', 'utf8');

    expect(() =>
      createMarkdownAgent({
        id: 'user:researcher',
        name: 'Researcher',
        description: '',
        kind: 'user',
        role: 'primary',
        source: { type: 'markdown' },
        systemPrompt: 'Prompt',
        toolNames: [],
        toolsEnabled: false,
        subagentIds: [],
        metadata: {},
      })
    ).toThrow(AgentSettingsError);
    expect(() => readMarkdownAgent('user:../escape')).toThrow(AgentSettingsError);
  });

  it('overwrites an existing agent on write and reports not found for missing reads', () => {
    const base = {
      id: 'user:editor' as const,
      name: 'Editor',
      description: '',
      kind: 'user' as const,
      role: 'primary' as const,
      source: { type: 'markdown' as const },
      toolNames: [],
      toolsEnabled: false,
      subagentIds: [],
      metadata: {},
    };
    createMarkdownAgent({ ...base, systemPrompt: 'First prompt.' });

    writeMarkdownAgent({ ...base, systemPrompt: 'Second prompt.' });

    expect(readMarkdownAgent('user:editor').profile.systemPrompt).toBe('Second prompt.');
    expect(() => readMarkdownAgent('user:ghost')).toThrow(AgentSettingsError);
    try {
      readMarkdownAgent('user:ghost');
    } catch (error) {
      expect((error as AgentSettingsError).status).toBe(404);
    }
  });

  it('previews markdown and rejects oversized content', () => {
    const preview = previewAgentMarkdown('---\nname: Preview\n---\nPrompt', 'user:preview');

    expect(preview.profile.name).toBe('Preview');
    expect(() => previewAgentMarkdown('x'.repeat(256 * 1024 + 1), 'user:preview')).toThrow(
      AgentSettingsError
    );
  });
});
