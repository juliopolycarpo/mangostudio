import { describe, expect, it } from 'bun:test';
import { composerAccent } from '../../../../src/features/chat/lib/composer-accent';

describe('composer accent', () => {
  it('keeps MangoStudio chats on the mango token', () => {
    expect(composerAccent({ kind: 'mangostudio', agentId: 'default' })).toBe(
      'var(--color-agent-mango)'
    );
  });

  it('falls back to mango when the runner has not been resolved yet', () => {
    // The composer renders before the chat query answers; a momentarily
    // missing runner must not flash a different colour.
    expect(composerAccent()).toBe('var(--color-agent-mango)');
  });

  it('wears the vendor colour for each external harness', () => {
    expect(composerAccent({ kind: 'external', targetId: 'codex' })).toBe(
      'var(--color-agent-codex)'
    );
    expect(composerAccent({ kind: 'external', targetId: 'claude' })).toBe(
      'var(--color-agent-claude)'
    );
    expect(composerAccent({ kind: 'external', targetId: 'cursor' })).toBe(
      'var(--color-agent-cursor)'
    );
  });

  it('gives a target this bundle predates the neutral colour, not MangoStudio own', () => {
    const future = { kind: 'external', targetId: 'aider' } as unknown as Parameters<
      typeof composerAccent
    >[0];
    expect(composerAccent(future)).toBe('var(--color-agent-generic)');
  });

  it('returns a var reference so the light theme override still applies', () => {
    // A resolved hex would freeze the dark palette into the inline style.
    for (const accent of [
      composerAccent(),
      composerAccent({ kind: 'external', targetId: 'codex' }),
    ]) {
      expect(accent.startsWith('var(--')).toBe(true);
    }
  });
});
