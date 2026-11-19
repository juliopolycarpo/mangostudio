import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import type { PromptSettings } from '@mangostudio/shared/prompt-rules';

import { composePrompt } from '../../../../src/modules/prompt-rules/application/prompt-composer';
import { moduleMockerFor } from '../../../support/mocks/module-mocks';

const mockModule = moduleMockerFor(import.meta.dir);

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
/** Fixed files the fake resolver was asked for, in order. */
let fixedKindsLoaded: string[] = [];

/** Where the fake registry "resolves" each fixed file; the stored setting path is only a label. */
const FAKE_FIXED_FILE_KEYS: Record<string, string> = {
  agents: '~/.mango/AGENTS.md',
  claude: '~/.claude/CLAUDE.md',
};

// The registry restores the module after every test, so it is faked again before each one.
beforeEach(async () => {
  fileContents = new Map();
  fixedKindsLoaded = [];
  await mockModule('../../../../src/modules/prompt-rules/application/rule-file-resolver', () => ({
    loadRuleFileContent: (path: string) => {
      if (fileContents.has(path)) return fileContents.get(path) ?? null;
      return null;
    },
    loadFixedRuleFileContent: (kind: string) => {
      fixedKindsLoaded.push(kind);
      const key = FAKE_FIXED_FILE_KEYS[kind] ?? '';
      return fileContents.get(key) ?? null;
    },
  }));
});

afterEach(() => {
  mock.restore();
});

describe('composePrompt', () => {
  it('returns base prompts unchanged when settings is undefined', () => {
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

  it('reads built-in files through the registry kind and custom files through their path', () => {
    fileContents.set('~/.mango/AGENTS.md', '# Fixed');
    fileContents.set('/etc/custom.md', '# Custom');

    composePrompt({
      settings: makeSettings({
        agentsMd: { ...makeSettings().agentsMd, enabled: true },
        // A stored path that points elsewhere must not redirect a built-in file.
        claudeMd: { ...makeSettings().claudeMd, enabled: true, path: '/etc/custom.md' },
        customRules: [
          {
            id: 'custom-1',
            label: 'Custom',
            path: '/etc/custom.md',
            enabled: true,
            injectionRole: 'system',
            sendFrequency: 'first-turn',
          },
        ],
      }),
      baseSystemPrompt: '',
      visiblePrompt: 'Hello',
      isFirstTurn: true,
    });

    expect(fixedKindsLoaded, '(fixed kinds loaded via the registry)').toEqual(['agents', 'claude']);
  });

  it('preserves base system prompt when composing with system rules', () => {
    fileContents.set('~/.mango/AGENTS.md', '# Extra');

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
