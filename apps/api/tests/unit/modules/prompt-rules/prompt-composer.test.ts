import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test';
import type { PromptSettings } from '@mangostudio/shared/prompt-rules';
import { composePrompt } from '../../../../src/modules/prompt-rules/application/prompt-composer';

function makeSettings(overrides?: Partial<PromptSettings>): PromptSettings {
  return {
    textSystemPrompt: '',
    imageSystemPrompt: '',
    agentsMd: {
      id: 'agentsMd',
      label: 'AGENTS.md',
      path: '~/.mango/AGENTS.md',
      enabled: false,
      injectionRole: 'system',
      sendFrequency: 'first-turn',
    },
    claudeMd: {
      id: 'claudeMd',
      label: 'CLAUDE.md',
      path: '~/.claude/CLAUDE.md',
      enabled: false,
      injectionRole: 'system',
      sendFrequency: 'first-turn',
    },
    customRules: [],
    ...overrides,
  };
}

let fileContents: Map<string, string | null> = new Map();

beforeEach(() => {
  fileContents = new Map();
});

afterEach(() => {
  mock.restore();
});

function setupMock() {
  void mock.module('../../../../src/modules/prompt-rules/application/rule-file-resolver', () => ({
    loadRuleFileContent: (path: string) => {
      if (fileContents.has(path)) return fileContents.get(path) ?? null;
      return null;
    },
  }));
}

describe('composePrompt', () => {
  it('returns base prompts unchanged when settings is undefined', () => {
    setupMock();

    const result = composePrompt({
      settings: undefined,
      baseSystemPrompt: 'You are a helpful assistant.',
      visiblePrompt: 'Hello',
      isFirstTurn: true,
    });

    expect(result.effectiveSystemPrompt).toBe('You are a helpful assistant.');
    expect(result.effectivePrompt).toBe('Hello');
    expect(result.appliedRuleFiles).toEqual([]);
  });

  it('returns base prompts unchanged when all rules are disabled', () => {
    setupMock();

    const result = composePrompt({
      settings: makeSettings(),
      baseSystemPrompt: 'You are a helpful assistant.',
      visiblePrompt: 'Hello',
      isFirstTurn: true,
    });

    expect(result.effectiveSystemPrompt).toBe('You are a helpful assistant.');
    expect(result.effectivePrompt).toBe('Hello');
    expect(result.appliedRuleFiles).toEqual([]);
  });

  it('appends enabled system rule content to effectiveSystemPrompt on first turn', () => {
    fileContents.set('~/.mango/AGENTS.md', '# Custom Rules\nBe concise.');
    setupMock();

    const result = composePrompt({
      settings: makeSettings({
        agentsMd: {
          id: 'agentsMd',
          label: 'AGENTS.md',
          path: '~/.mango/AGENTS.md',
          enabled: true,
          injectionRole: 'system',
          sendFrequency: 'first-turn',
        },
      }),
      baseSystemPrompt: 'You are a helpful assistant.',
      visiblePrompt: 'Hello',
      isFirstTurn: true,
    });

    expect(result.effectiveSystemPrompt).toContain('You are a helpful assistant.');
    expect(result.effectiveSystemPrompt).toContain('# Custom Rules');
    expect(result.effectiveSystemPrompt).toContain('mangostudio-rule-file');
    expect(result.effectiveSystemPrompt).toContain('label="AGENTS.md"');
    expect(result.appliedRuleFiles).toEqual([
      { label: 'AGENTS.md', path: '~/.mango/AGENTS.md', role: 'system' },
    ]);
    expect(result.effectivePrompt).toBe('Hello');
  });

  it('does not apply first-turn rules on subsequent turns', () => {
    fileContents.set('~/.mango/AGENTS.md', '# Custom Rules');
    setupMock();

    const result = composePrompt({
      settings: makeSettings({
        agentsMd: {
          id: 'agentsMd',
          label: 'AGENTS.md',
          path: '~/.mango/AGENTS.md',
          enabled: true,
          injectionRole: 'system',
          sendFrequency: 'first-turn',
        },
      }),
      baseSystemPrompt: 'You are a helpful assistant.',
      visiblePrompt: 'Hello',
      isFirstTurn: false,
    });

    expect(result.effectiveSystemPrompt).toBe('You are a helpful assistant.');
    expect(result.appliedRuleFiles).toEqual([]);
  });

  it('applies every-turn rules on subsequent turns', () => {
    fileContents.set('~/.mango/AGENTS.md', '# Always On');
    setupMock();

    const result = composePrompt({
      settings: makeSettings({
        agentsMd: {
          id: 'agentsMd',
          label: 'AGENTS.md',
          path: '~/.mango/AGENTS.md',
          enabled: true,
          injectionRole: 'system',
          sendFrequency: 'every-turn',
        },
      }),
      baseSystemPrompt: 'You are a helpful assistant.',
      visiblePrompt: 'Hello',
      isFirstTurn: false,
    });

    expect(result.effectiveSystemPrompt).toContain('You are a helpful assistant.');
    expect(result.effectiveSystemPrompt).toContain('# Always On');
    expect(result.appliedRuleFiles).toHaveLength(1);
  });

  it('wraps user-role rules around visible prompt with delimiters', () => {
    fileContents.set('~/.claude/CLAUDE.md', '# User Context');
    setupMock();

    const result = composePrompt({
      settings: makeSettings({
        claudeMd: {
          id: 'claudeMd',
          label: 'CLAUDE.md',
          path: '~/.claude/CLAUDE.md',
          enabled: true,
          injectionRole: 'user',
          sendFrequency: 'first-turn',
        },
      }),
      baseSystemPrompt: 'You are a helpful assistant.',
      visiblePrompt: 'Hello',
      isFirstTurn: true,
    });

    expect(result.effectivePrompt).toContain('<mangostudio-rule-context>');
    expect(result.effectivePrompt).toContain('<mangostudio-rule-file label="CLAUDE.md"');
    expect(result.effectivePrompt).toContain('# User Context');
    expect(result.effectivePrompt).toContain('</mangostudio-rule-context>');
    expect(result.effectivePrompt).toContain('Hello');
    expect(result.appliedRuleFiles).toEqual([
      { label: 'CLAUDE.md', path: '~/.claude/CLAUDE.md', role: 'user' },
    ]);
  });

  it('combines system and user rules correctly', () => {
    fileContents.set('~/.mango/AGENTS.md', '# System Rules');
    fileContents.set('~/.claude/CLAUDE.md', '# User Rules');
    setupMock();

    const result = composePrompt({
      settings: makeSettings({
        agentsMd: {
          id: 'agentsMd',
          label: 'AGENTS.md',
          path: '~/.mango/AGENTS.md',
          enabled: true,
          injectionRole: 'system',
          sendFrequency: 'first-turn',
        },
        claudeMd: {
          id: 'claudeMd',
          label: 'CLAUDE.md',
          path: '~/.claude/CLAUDE.md',
          enabled: true,
          injectionRole: 'user',
          sendFrequency: 'first-turn',
        },
      }),
      baseSystemPrompt: 'You are a helpful assistant.',
      visiblePrompt: 'Hello',
      isFirstTurn: true,
    });

    expect(result.effectiveSystemPrompt).toContain('# System Rules');
    expect(result.effectivePrompt).toContain('# User Rules');
    expect(result.appliedRuleFiles).toEqual([
      { label: 'AGENTS.md', path: '~/.mango/AGENTS.md', role: 'system' },
      { label: 'CLAUDE.md', path: '~/.claude/CLAUDE.md', role: 'user' },
    ]);
  });

  it('skips enabled rules when file content is not available', () => {
    setupMock();

    const result = composePrompt({
      settings: makeSettings({
        agentsMd: {
          id: 'agentsMd',
          label: 'AGENTS.md',
          path: '~/.mango/AGENTS.md',
          enabled: true,
          injectionRole: 'system',
          sendFrequency: 'first-turn',
        },
      }),
      baseSystemPrompt: 'You are a helpful assistant.',
      visiblePrompt: 'Hello',
      isFirstTurn: true,
    });

    expect(result.effectiveSystemPrompt).toBe('You are a helpful assistant.');
    expect(result.appliedRuleFiles).toEqual([]);
  });

  it('handles custom rules alongside fixed rules', () => {
    fileContents.set('~/.mango/AGENTS.md', '# Fixed');
    fileContents.set('/etc/custom.md', '# Custom');
    setupMock();

    const result = composePrompt({
      settings: makeSettings({
        agentsMd: {
          id: 'agentsMd',
          label: 'AGENTS.md',
          path: '~/.mango/AGENTS.md',
          enabled: true,
          injectionRole: 'system',
          sendFrequency: 'every-turn',
        },
        customRules: [
          {
            id: 'custom-1',
            label: 'Custom',
            path: '/etc/custom.md',
            enabled: true,
            injectionRole: 'user',
            sendFrequency: 'first-turn',
          },
        ],
      }),
      baseSystemPrompt: '',
      visiblePrompt: 'Hello',
      isFirstTurn: true,
    });

    expect(result.appliedRuleFiles).toHaveLength(2);
    expect(result.effectiveSystemPrompt).toContain('# Fixed');
    expect(result.effectivePrompt).toContain('# Custom');
  });

  it('preserves base system prompt when composing with system rules', () => {
    fileContents.set('~/.mango/AGENTS.md', '# Extra');
    setupMock();

    const result = composePrompt({
      settings: makeSettings({
        agentsMd: {
          id: 'agentsMd',
          label: 'AGENTS.md',
          path: '~/.mango/AGENTS.md',
          enabled: true,
          injectionRole: 'system',
          sendFrequency: 'first-turn',
        },
      }),
      baseSystemPrompt: 'BASE',
      visiblePrompt: 'Hello',
      isFirstTurn: true,
    });

    expect(result.effectiveSystemPrompt).toMatch(/^BASE/);
  });

  it('generates deterministic output for the same inputs', () => {
    fileContents.set('~/.mango/AGENTS.md', '# Content');
    setupMock();

    const a = composePrompt({
      settings: makeSettings({
        agentsMd: {
          id: 'agentsMd',
          label: 'AGENTS.md',
          path: '~/.mango/AGENTS.md',
          enabled: true,
          injectionRole: 'system',
          sendFrequency: 'every-turn',
        },
      }),
      baseSystemPrompt: 'Base',
      visiblePrompt: 'Hi',
      isFirstTurn: true,
    });

    const b = composePrompt({
      settings: makeSettings({
        agentsMd: {
          id: 'agentsMd',
          label: 'AGENTS.md',
          path: '~/.mango/AGENTS.md',
          enabled: true,
          injectionRole: 'system',
          sendFrequency: 'every-turn',
        },
      }),
      baseSystemPrompt: 'Base',
      visiblePrompt: 'Hi',
      isFirstTurn: true,
    });

    expect(a.effectiveSystemPrompt).toBe(b.effectiveSystemPrompt);
    expect(a.effectivePrompt).toBe(b.effectivePrompt);
    expect(a.appliedRuleFiles).toEqual(b.appliedRuleFiles);
  });
});
